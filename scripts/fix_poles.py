#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AeroFlow Sky — 风场数据后处理：修正极点行
============================================

背景
----
GFS 在极点处给的是一圈网格：同一个风矢量在不同经度上被分解成不同的
(u, v) 本地分量。烘焙时若直接双线性插值，极点行的风矢量会随查询经度
旋转一整圈（实测 u/v 极差 36–47 m/s），而物理上极点是单点、风矢量唯一。

影响
----
跨极航线（如 PEK→JFK）会经过 lat≈90，该处的风矢量、温度、湍流指数
都会随经度漂移，导致 RoutePoint 里那几个点的数据不可信。

做法
----
对输出的 AFLW 文件做原地修正：把 lat=±90 的两行替换为
「整圈矢量的球面平均」——先按各自经度还原成世界坐标矢量，平均后再
投影回经度 0 的本地东/北方向。

用法
----
    python scripts/fix_poles.py                    # 修正 public/data 下的目录
    python scripts/fix_poles.py --dry-run          # 只报告不写入
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np


def pole_mean_uv(u_row: np.ndarray, v_row: np.ndarray, lat_deg: float) -> tuple[float, float]:
    """把极点纬圈上的 (u, v) 还原成三维矢量平均，再投影回经度 0 的本地分量。

    南北半球的东向定义镜像：南极处"东"的绕行方向与北极相反。
    """
    n = u_row.size
    lam = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    sign = 1.0 if lat_deg >= 0.0 else -1.0

    # 本地东向与北向在世界坐标中的单位矢量（极点处切平面平行赤道面）
    ex = -np.sin(lam) * sign
    ez = -np.cos(lam) * sign
    nx = -np.cos(lam)
    nz = np.sin(lam) * sign

    wx = float(np.nanmean(u_row * ex + v_row * nx))
    wz = float(np.nanmean(u_row * ez + v_row * nz))

    u0 = wx * ex[0] + wz * ez[0]
    v0 = wx * nx[0] + wz * nz[0]
    return float(u0), float(v0)


def read_aflw(path: str) -> tuple[dict, np.ndarray, int]:
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:4] != b"AFLW":
        raise ValueError(f"{path} 不是 AFLW 文件")
    hdr_len = int.from_bytes(raw[4:8], "little")
    header = json.loads(raw[8 : 8 + hdr_len].decode("utf-8"))
    payload = np.frombuffer(raw, dtype="<f2", offset=8 + hdr_len)
    return header, payload.astype(np.float32), 8 + hdr_len


def write_aflw(path: str, header: dict, payload: np.ndarray, header_offset: int) -> None:
    h = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(h) != header_offset - 8:
        raise ValueError("header 长度变化，无法原地写回")
    with open(path, "wb") as f:
        f.write(b"AFLW")
        f.write(len(h).to_bytes(4, "little"))
        f.write(h)
        f.write(payload.astype("<f2").tobytes())


def fix_file(path: str, dry_run: bool) -> dict:
    header, data, hdr_off = read_aflw(path)
    g = header["grid"]
    n_lat, n_lon = g["nLat"], g["nLon"]
    n_levels = len(header["levels"])
    n_steps = len(header["steps"])

    levels = [lv["hPa"] for lv in header["levels"]]
    # 层序与打包顺序一致（bake 脚本按 levels_sorted 写入）
    n_per_step = n_levels * n_lat * n_lon * 4
    flat = data.reshape(n_steps, n_levels, n_lat, n_lon, 4)

    report = {"file": os.path.basename(path), "fixed": [], "maxBefore": 0.0}

    for s in range(n_steps):
        for l in range(n_levels):
            for edge, lat_deg in ((0, g["latMin"]), (n_lat - 1, g["latMax"])):
                if abs(abs(lat_deg) - 90.0) > 1e-6:
                    continue
                block = flat[s, l, edge]  # (n_lon, 4)
                u = block[:, 0].copy()
                v = block[:, 1].copy()

                # 记录修正前的极差
                spread = max(float(u.max() - u.min()), float(v.max() - v.min()))
                report["maxBefore"] = max(report["maxBefore"], spread)
                if spread < 1e-3:
                    continue

                u0, v0 = pole_mean_uv(u, v, lat_deg)
                block[:, 0] = u0
                block[:, 1] = v0
                block[:, 2] = float(np.nanmean(block[:, 2]))  # CAT
                block[:, 3] = float(np.nanmean(block[:, 3]))  # 温度
                report["fixed"].append(
                    {"step": s, "hPa": levels[l], "lat": lat_deg, "spreadBefore": round(spread, 2)}
                )

    if not dry_run and report["fixed"]:
        write_aflw(path, header, flat.reshape(-1), hdr_off)
        report["written"] = True
    else:
        report["written"] = False
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="修正 AFLW 风场文件的极点行")
    ap.add_argument("--dir", default=None, help="包含 wind-manifest.json 的目录")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    data_dir = args.dir or os.path.join(root, "public", "data")
    manifest_path = os.path.join(data_dir, "wind-manifest.json")
    if not os.path.exists(manifest_path):
        print(f"[fix] 找不到 {manifest_path}")
        return 1

    manifest = json.load(open(manifest_path, encoding="utf-8"))
    target = os.path.join(data_dir, manifest["file"])
    print(f"[fix] 目标：{manifest['file']}")
    rep = fix_file(target, args.dry_run)
    print(f"[fix] 极点行修正前最大极差：{rep['maxBefore']:.2f} m/s")
    print(f"[fix] 需要修正的 (step, level, lat) 组合：{len(rep['fixed'])}")
    for item in rep["fixed"][:6]:
        print(f"       step={item['step']} {item['hPa']}hPa lat={item['lat']:+.0f} 极差 {item['spreadBefore']} m/s")
    print(f"[fix] 写入：{'是' if rep['written'] else '否（dry-run 或无需修正）'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
