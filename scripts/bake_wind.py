#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AeroFlow Sky — 高空风场烘焙管线
==================================

从 NOAA NOMADS 拉取 GFS 0.25° 高空气压层 GRIB2 子集（U/V 风 + 温度），
计算 Ellrod 晴空湍流指数 TI1，降采样后烘焙成浏览器可直接上传 GPU 的
AFLW 二进制（float16 / RGBA = u, v, cat, temp）。

用法
----
    python scripts/bake_wind.py                     # 默认：最近可用周期，4 个预报时效
    python scripts/bake_wind.py --hours 0,6,12,24,36
    python scripts/bake_wind.py --step-deg 1.0      # 更清晰（文件更大）
    python scripts/bake_wind.py --cycle 20261031/00 --keep-raw

依赖：numpy, xarray, cfgrib, eccodes（pip install numpy xarray cfgrib eccodes）

输出
----
    public/data/wind-gfs-<cycle>-<hash>.bin
    public/data/wind-manifest.json      （前端读取的清单）
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np

NOMADS = "https://nomads.ncep.noaa.gov"
FILTER = NOMADS + "/cgi-bin/filter_gfs_0p25.pl"
PROD = NOMADS + "/pub/data/nccf/com/gfs/prod"

EARTH_R = 6371000.0
# 标准大气下各气压层的近似几何高度（米），用于垂直风切变
STD_HEIGHT_M = {200: 11784.0, 250: 10363.0, 300: 9164.0}

# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #


def log(msg: str) -> None:
    print(f"[bake] {msg}", flush=True)


def http_ok(url: str, timeout: int = 25) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return 200 <= r.status < 400
    except Exception:
        return False


def download(url: str, dest: str, attempts: int = 3, timeout: int = 300) -> int:
    for i in range(1, attempts + 1):
        try:
            t0 = time.time()
            with urllib.request.urlopen(url, timeout=timeout) as r:
                data = r.read()
            if len(data) < 4096:
                raise RuntimeError(f"response too small ({len(data)} B)")
            with open(dest, "wb") as f:
                f.write(data)
            log(f"  ↓ {os.path.basename(dest)}  {len(data)/1e6:.1f} MB  {time.time()-t0:.1f}s")
            return len(data)
        except Exception as exc:  # noqa: BLE001
            log(f"  ! 下载失败 ({i}/{attempts}): {exc}")
            time.sleep(3 * i)
    raise RuntimeError(f"无法下载 {url}")


# --------------------------------------------------------------------------- #
# 周期探测
# --------------------------------------------------------------------------- #


def latest_cycle() -> tuple[str, int]:
    """返回最近一个 f000 可用的 (YYYYMMDD, HH)。GFS 有约 3.5–5h 的滞后。"""
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(0, 3):
        day = now - dt.timedelta(days=back)
        ymd = day.strftime("%Y%m%d")
        for hh in (18, 12, 6, 0):
            url = f"{PROD}/gfs.{ymd}/{hh:02d}/atmos/gfs.t{hh:02d}z.pgrb2.0p25.f000"
            if http_ok(url):
                return ymd, hh
    raise RuntimeError("找不到可用的 GFS 周期（网络或 NOMADS 目录结构变化）")


def step_available(ymd: str, hh: int, fhr: int) -> bool:
    url = f"{PROD}/gfs.{ymd}/{hh:02d}/atmos/gfs.t{hh:02d}z.pgrb2.0p25.f{fhr:03d}"
    return http_ok(url)


# --------------------------------------------------------------------------- #
# 下载 & 解析
# --------------------------------------------------------------------------- #


def gfs_subset(ymd: str, hh: int, fhr: int, levels: list[int], dest: str) -> dict:
    """下载指定预报时效的 U/V/T（不含 HGT，垂直切变用标准高度近似）。"""
    leva = "&".join(f"lev_{lv}_mb=on" for lv in levels)
    url = (
        f"{FILTER}?dir=%2Fgfs.{ymd}%2F{hh:02d}%2Fatmos"
        f"&file=gfs.t{hh:02d}z.pgrb2.0p25.f{fhr:03d}"
        f"&var_UGRD=on&var_VGRD=on&var_TMP=on"
        f"&{leva}&subregion=&leftlon=0&rightlon=359.75&toplat=90&bottomlat=-90"
    )
    log(f"f{fhr:03d} 子集请求 …")
    download(url, dest)

    import xarray as xr  # 延迟导入，便于 --help 快速返回

    ds = xr.open_dataset(dest, engine="cfgrib", backend_kwargs={"indexpath": ""})
    ds = ds.load()
    ds.close()

    lat = ds["latitude"].values.astype(np.float64)          # 90 → -90 递减
    lon = ds["longitude"].values.astype(np.float64)         # 0 → 359.75
    out = {
        "lat": lat,
        "lon": lon,
        "u": {},
        "v": {},
        "t": {},
        "valid": np.datetime64(ds["valid_time"].values),
    }
    for lv in levels:
        sel = ds.sel(isobaricInhPa=lv)
        out["u"][lv] = np.asarray(sel["u"].values, dtype=np.float64)
        out["v"][lv] = np.asarray(sel["v"].values, dtype=np.float64)
        out["t"][lv] = np.asarray(sel["t"].values, dtype=np.float64)
    return out


# --------------------------------------------------------------------------- #
# 重采样
# --------------------------------------------------------------------------- #


def canonicalize(field: np.ndarray, lat: np.ndarray, lon: np.ndarray
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """统一成「纬度升序、经度升序且从 0°E 起、不含重复端点列」的网格。

    GFS 不同子集返回的经纬顺序并不一致（单层请求是升序，多层请求有时是降序），
    所以在任何计算之前先规范化，避免后面所有算子都要考虑方向。
    该变换是幂等的：重复调用不会改变结果。
    """
    f = np.asarray(field, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)

    if lat[0] > lat[-1]:
        f = f[::-1, :]
        lat = lat[::-1]

    # 丢掉与首列重复的 360° 端点列（若存在）
    if lon.size > 1 and abs((lon[-1] - lon[0]) - 360.0) < 1e-6:
        f = f[:, :-1]
        lon = lon[:-1]

    if lon[0] < 0.0:
        shift = int(np.searchsorted(lon, 0.0))
        f = np.concatenate([f[:, shift:], f[:, :shift]], axis=1)
        lon = np.concatenate([lon[shift:], lon[:shift] + 360.0])

    return f, lat, lon


def bilinear(field: np.ndarray, lat: np.ndarray, lon: np.ndarray,
             tlats: np.ndarray, tlons: np.ndarray) -> np.ndarray:
    """在规范化网格上做双线性插值。目标经度可含 360° 端点（补周期列）。"""
    # 补充周期性列，使 tlons 落在 [lon[0], lon[-1]+dlon] 内
    dlon = (lon[-1] - lon[0]) / max(1, lon.size - 1)
    f = np.concatenate([field, field[:, :1]], axis=1)
    lo = np.concatenate([lon, [lon[0] + 360.0]])
    if tlons[-1] <= lo[-1] + 1e-9:
        pass
    else:  # 目标超出则可安全外推
        f = np.concatenate([f, f[:, 1:2]], axis=1)
        lo = np.concatenate([lo, [lo[0] + 720.0]])

    rows = np.empty((lat.size, tlons.size), dtype=np.float64)
    for i in range(lat.size):
        rows[i] = np.interp(tlons, lo, f[i])

    out = np.empty((tlats.size, tlons.size), dtype=np.float64)
    for j in range(tlons.size):
        out[:, j] = np.interp(tlats, lat, rows[:, j])
    return out


def resample(field: np.ndarray, lat: np.ndarray, lon: np.ndarray,
             tlats: np.ndarray, tlons: np.ndarray) -> np.ndarray:
    f, la, lo = canonicalize(field, lat, lon)
    return bilinear(f, la, lo, tlats, tlons)


# --------------------------------------------------------------------------- #
# CAT：Ellrod TI1
# --------------------------------------------------------------------------- #


def gradient_metrics(u: np.ndarray, v: np.ndarray, lat: np.ndarray,
                     dlon_deg: float, dlat_deg: float) -> np.ndarray:
    """水平总变形 DEF = sqrt(DST² + DSH²)，单位 1/s。lat 需为升序。"""
    dlat = np.deg2rad(dlat_deg)
    dlon = np.deg2rad(dlon_deg)
    coslat = np.clip(np.cos(np.deg2rad(lat)), 0.15, 1.0)[:, None]

    dudy = np.gradient(u, axis=0) / (EARTH_R * dlat)
    dudx = np.gradient(u, axis=1) / (EARTH_R * dlon * coslat)
    dvdy = np.gradient(v, axis=0) / (EARTH_R * dlat)
    dvdx = np.gradient(v, axis=1) / (EARTH_R * dlon * coslat)

    dst = dudx - dvdy
    dsh = dvdx + dudy
    return np.hypot(dst, dsh)


def ellrod_cat(uv: dict, lat: np.ndarray, levels: list[int]) -> dict:
    """对每个层次计算 TI1 = VWS × DEF，并归一到 0..1（p99.5 作为饱和点）。

    输入先规范化到升序网格：经度网格间距由源网格反推，避免硬编码 0.25°。
    """
    lv = sorted(levels)
    canon = {k: {} for k in ("u", "v")}
    lat_asc = None
    for level in lv:
        for k in ("u", "v"):
            f, la, lo = canonicalize(uv[k][level], lat, uv["lon"])
            canon[k][level] = f
            lat_asc = la
    dlon_deg = 360.0 / (canon["u"][lv[0]].shape[1] - 1)
    dlat_deg = 180.0 / (canon["u"][lv[0]].shape[0] - 1)
    log(f"  CAT 网格：{dlat_deg:.3f}° × {dlon_deg:.3f}°")

    shear = {}
    for i, level in enumerate(lv):
        if level == lv[0]:
            below, above = level, lv[1]
        elif level == lv[-1]:
            below, above = lv[-2], level
        else:
            below, above = lv[i - 1], lv[i + 1]
        dz = abs(STD_HEIGHT_M[below] - STD_HEIGHT_M[above])
        du = canon["u"][above] - canon["u"][below]
        dv = canon["v"][above] - canon["v"][below]
        shear[level] = np.hypot(du, dv) / dz  # (m/s)/m

    out = {}
    for level in lv:
        defo = gradient_metrics(canon["u"][level], canon["v"][level], lat_asc,
                                dlon_deg, 1.0)
        ti1 = defo * shear[level]
        p = float(np.nanpercentile(np.abs(ti1), 99.5)) or 1.0
        out[level] = np.clip((np.abs(ti1) / p) ** 0.65, 0.0, 1.0)
    return out


# --------------------------------------------------------------------------- #
# 二进制打包
# --------------------------------------------------------------------------- #


def _pole_vector_mean(u_row: np.ndarray, v_row: np.ndarray, lat_deg: float):
    """把极点纬圈上的 u/v 还原成三维风矢量再取平均。

    物理事实：极点是单点，风矢量唯一。但 GFS 在极点处给的是一圈网格，
    同一矢量在不同经度上被分解成不同的 (u, v) 分量。直接对这些分量做
    双线性插值，会让"极点风"随查询经度旋转一整圈（实测 u/v 极差 36–47 m/s）。

    做法：每个样本按它自己的经度还原成世界坐标矢量，平均后再投影回
    经度 0 的本地东/北方向。

    注意南北半球的东向定义镜像：南极处"东"的绕行方向与北极相反。
    """
    n = u_row.size
    lam = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    sign = 1.0 if lat_deg >= 0 else -1.0

    # 本地东向单位矢量的世界坐标（纬度 ±90 处，切平面与赤道面平行）
    # 北极：east = (-sinλ, 0, -cosλ)；南极镜像后符号取反
    ex = -np.sin(lam) * sign
    ez = -np.cos(lam) * sign
    # 极点处"北向"没有意义，风矢量的南北分量在该点全部退化为径向，
    # 这里把 v 也按本地北向投影（北极北向指向 -X 方向即经度 180）
    nx = -np.cos(lam)
    nz = np.sin(lam) * sign

    # 累加成世界矢量
    wx = float(np.nanmean(u_row * ex + v_row * nx))
    wz = float(np.nanmean(u_row * ez + v_row * nz))

    # 投影回经度 0 处的本地分量
    u0 = wx * ex[0] + wz * ez[0]
    v0 = wx * nx[0] + wz * nz[0]
    return (float(u0), float(v0))


def pack_bin(path: str, header: dict, data: np.ndarray) -> None:
    h = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as f:
        f.write(b"AFLW")
        f.write(len(h).to_bytes(4, "little"))
        f.write(h)
        f.write(data.astype("<f2").tobytes())


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #


def main() -> int:
    ap = argparse.ArgumentParser(description="烘焙 GFS 高空风场 → AFLW 二进制")
    ap.add_argument("--hours", default="0,6,12,24", help="预报时效（小时），逗号分隔")
    ap.add_argument("--levels", default="200,250,300", help="气压层 hPa")
    ap.add_argument("--step-deg", type=float, default=1.5, help="输出网格步长（度）")
    ap.add_argument("--cycle", default=None, help="手动指定 YYYYMMDD/HH")
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--keep-raw", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir or os.path.join(root, "public", "data")
    raw_dir = os.path.join(root, ".cache", "grib")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(raw_dir, exist_ok=True)

    hours = [int(x) for x in args.hours.split(",") if x.strip() != ""]
    levels = [int(x) for x in args.levels.split(",") if x.strip() != ""]
    levels_sorted = sorted(levels)
    step = float(args.step_deg)

    if args.cycle:
        ymd, hh = args.cycle.split("/")
        ymd, hh = ymd.strip(), int(hh)
    else:
        ymd, hh = latest_cycle()
    log(f"GFS 周期：{ymd} {hh:02d}Z   时效：{hours} h   层次：{levels} hPa   网格：{step}°")

    # 目标网格（经度 0..360 含端点，纬度为升序）
    tlons = np.arange(0.0, 360.0 + 1e-9, step)
    tlats = np.arange(-90.0, 90.0 + 1e-9, step)

    payload_steps = []
    stats = []
    lat_ref = lon_ref = None

    for fhr in hours:
        if not step_available(ymd, hh, fhr):
            log(f"f{fhr:03d} 在 {ymd} {hh:02d}Z 不可用，跳过")
            continue
        raw = os.path.join(raw_dir, f"gfs_{ymd}_{hh:02d}_f{fhr:03d}.grb2")
        if not (os.path.exists(raw) and os.path.getsize(raw) > 4096):
            ds = gfs_subset(ymd, hh, fhr, levels, raw)
        else:
            log(f"  · 复用缓存 {os.path.basename(raw)}")
            import xarray as xr

            ds = xr.open_dataset(raw, engine="cfgrib", backend_kwargs={"indexpath": ""}).load()
            ds.close()
            ds = {
                "lat": ds["latitude"].values.astype(np.float64),
                "lon": ds["longitude"].values.astype(np.float64),
                "u": {lv: np.asarray(ds.sel(isobaricInhPa=lv)["u"].values, dtype=np.float64) for lv in levels},
                "v": {lv: np.asarray(ds.sel(isobaricInhPa=lv)["v"].values, dtype=np.float64) for lv in levels},
                "t": {lv: np.asarray(ds.sel(isobaricInhPa=lv)["t"].values, dtype=np.float64) for lv in levels},
            }
        lat, lon = ds["lat"], ds["lon"]
        lat_ref, lon_ref = lat, lon

        log("计算 CAT (Ellrod TI1) …")
        cat = ellrod_cat({"u": ds["u"], "v": ds["v"], "lon": ds["lon"]}, lat, levels)

        for lv in levels_sorted:
            u_r = resample(ds["u"][lv], lat, lon, tlats, tlons)
            v_r = resample(ds["v"][lv], lat, lon, tlats, tlons)
            t_r = resample(ds["t"][lv], lat, lon, tlats, tlons)
            c_r = np.clip(resample(cat[lv], lat, lon, tlats, tlons), 0.0, 1.0)

            # 极点是单点，风矢量必须唯一。
            #
            # 但 GFS 的极圈网格在极点处是一个「纬圈」，不同经度上的 u/v
            # 分量方向不同（同一个风矢量在不同经度上的分解）。直接双线性
            # 插值会把它们当成不同值，结果就是极点行的风矢量随经度
            # 旋转一整圈（实测 u/v 极差达 36–47 m/s）。
            #
            # 正确做法：把极点行替换为该纬度上所有经度矢量的平均值。
            # 注意是「矢量平均」——先按球面方向还原再平均，而不是
            # 直接对 u/v 取算术平均（那个结果取决于网格从哪个经度起算）。
            for edge in (0, len(tlats) - 1):
                if abs(abs(tlats[edge]) - 90.0) < 1e-6:
                    u_r[edge, :] = _pole_vector_mean(u_r[edge, :], v_r[edge, :], tlats[edge])[0]
                    v_r[edge, :] = _pole_vector_mean(u_r[edge, :], v_r[edge, :], tlats[edge])[1]
                    t_r[edge, :] = float(np.nanmean(t_r[edge, :]))
                    c_r[edge, :] = float(np.nanmean(c_r[edge, :]))

            spd = np.hypot(u_r, v_r)
            stats.append({
                "hour": fhr,
                "level": lv,
                "maxWind": round(float(np.nanmax(spd)), 1),
                "meanWind": round(float(np.nanmean(spd)), 1),
                "maxCat": round(float(np.nanmax(c_r)), 3),
                "hotFrac": round(float(np.mean(c_r > 0.6)), 4),
            })
            log(f"  {lv} hPa  f{fhr:03d}  max {np.nanmax(spd):5.1f} m/s   "
                f"mean {np.nanmean(spd):4.1f}   CAT>0.6 {np.mean(c_r > 0.6)*100:.2f}%")

            stack = np.stack([u_r, v_r, c_r, t_r], axis=-1)  # (lat, lon, 4)
            payload_steps.append(stack)

        if not args.keep_raw:
            try:
                os.remove(raw)
            except OSError:
                pass

    if not payload_steps:
        log("没有任何时效可用，退出")
        return 1

    data = np.concatenate([s.reshape(-1, 4) for s in payload_steps], axis=0)
    n_lat, n_lon = len(tlats), len(tlons)
    used_hours = sorted({s["hour"] for s in stats})

    valid_times = []
    for h in used_hours:
        t = dt.datetime.strptime(ymd, "%Y%m%d").replace(tzinfo=dt.timezone.utc) + dt.timedelta(hours=hh + h)
        valid_times.append(t.strftime("%Y-%m-%dT%H:%M:%SZ"))

    header = {
        "magic": "AFLW1",
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "NOAA/NCEP GFS 0.25° · NOMADS filter (UGRD/VGRD/TMP)",
        "cycle": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}T{hh:02d}:00Z",
        "encoding": "float16",
        "channels": ["u", "v", "cat", "temp"],
        "units": {"u": "m/s", "v": "m/s", "cat": "0-1 (Ellrod TI1)", "temp": "K"},
        "grid": {
            "nLat": n_lat, "nLon": n_lon,
            "latMin": float(tlats[0]), "latMax": float(tlats[-1]),
            "lonMin": float(tlons[0]), "lonMax": float(tlons[-1]),
            "latOrder": "ascending", "lonOrder": "ascending",
            "wrapLon": True,
        },
        "levels": [{"hPa": lv, "fl": int(round(STD_HEIGHT_M[lv] / 0.3048 / 100))} for lv in levels_sorted],
        "steps": [{"hour": h, "validTime": v} for h, v in zip(used_hours, valid_times)],
        "layout": "step-major, then level, then lat (asc), then lon (asc), RGBA float16",
        "stats": stats,
        "catMethod": "Ellrod TI1 = horizontal deformation × vertical wind shear; "
                     "normalised to 0-1 at the 99.5th percentile of the field",
    }

    digest = hashlib.sha1(data.tobytes()[:200000] + str(header).encode()).hexdigest()[:8]
    fname = f"wind-gfs-{ymd}-{hh:02d}z-{digest}.bin"
    fpath = os.path.join(out_dir, fname)
    log(f"写入 {fname} …")
    pack_bin(fpath, header, data)
    size_mb = os.path.getsize(fpath) / 1e6
    log(f"完成：{fpath}  {size_mb:.2f} MB  ({data.shape[0]} 像素/步层)")

    manifest_path = os.path.join(out_dir, "wind-manifest.json")
    manifest = {
        "version": 1,
        "file": fname,
        "bytes": os.path.getsize(fpath),
        "header": header,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    log(f"清单：{manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
