/**
 * AFLW 风场数据加载与采样
 * ---------------------------------------------------------------------------
 * AFLW（AeroFlow Wind）是 scripts/bake_wind.py 生成的紧凑二进制：
 *
 *   magic      4B   "AFLW"
 *   hdrLen     4B   uint32 LE
 *   header     hdrLen B  UTF-8 JSON
 *   payload    float16 RGBA，步长主序：
 *              [step][level][lat asc][lon asc] → (u, v, cat, temp)
 *
 * 采样提供三线性（经度环绕、纬度夹取）+ 时间线性插值，
 * 是航线推演每帧都要调用的热点函数，所以全程用扁平数组避免对象分配。
 */

import type { Wind } from '../core/atmos';

export type GridSpec = {
  nLat: number;
  nLon: number;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
};

export type LevelSpec = { hPa: number; fl: number };
export type StepSpec = { hour: number; validTime: string };

export type WindHeader = {
  magic: string;
  generated: string;
  source: string;
  cycle: string;
  encoding: string;
  channels: string[];
  units: Record<string, string>;
  grid: GridSpec;
  levels: LevelSpec[];
  steps: StepSpec[];
  layout: string;
  stats: Array<{
    hour: number;
    level: number;
    maxWind: number;
    meanWind: number;
    maxCat: number;
    hotFrac: number;
  }>;
  catMethod: string;
};

export type WindManifest = {
  version: number;
  file: string;
  bytes: number;
  header: WindHeader;
};

export type WindField = {
  header: WindHeader;
  /** RGBA 交错，长度 = steps × levels × nLat × nLon × 4 */
  data: Float32Array;
  grid: GridSpec;
  levels: number[];
  steps: number[];
  /** 每个采样点的完整数据，供 GPU 上传 */
  stridePerLevel: number;
};

/** IEEE 754 half → float32 */
const halfTable = (() => {
  const t = new Float32Array(65536);
  const u32 = new Uint32Array(1);
  const f32 = new Float32Array(u32.buffer);
  for (let i = 0; i < 65536; i++) {
    const sign = (i & 0x8000) >> 15;
    const exp = (i & 0x7c00) >> 10;
    const frac = i & 0x03ff;
    let val: number;
    if (exp === 0) val = frac === 0 ? 0 : frac * Math.pow(2, -24);
    else if (exp === 0x1f) val = frac === 0 ? Infinity : NaN;
    else val = (1 + frac / 1024) * Math.pow(2, exp - 15);
    t[i] = sign ? -val : val;
  }
  void u32; void f32;
  return t;
})();

export function decodeHalf(u16: Uint16Array): Float32Array {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = halfTable[u16[i]];
  return out;
}

export async function loadWindField(
  baseUrl = '/data/',
  onProgress?: (loaded: number, total: number) => void,
): Promise<WindField> {
  const manifestRes = await fetch(`${baseUrl}wind-manifest.json`, { cache: 'no-cache' });
  if (!manifestRes.ok) throw new Error(`风场清单不可用（HTTP ${manifestRes.status}）`);
  const manifest = (await manifestRes.json()) as WindManifest;

  const binRes = await fetch(`${baseUrl}${manifest.file}`);
  if (!binRes.ok) throw new Error(`风场数据不可用（HTTP ${binRes.status}）`);

  const total = manifest.bytes;
  const reader = binRes.body?.getReader();
  let buf: Uint8Array;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.(loaded, total);
      }
    }
    buf = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
  } else {
    buf = new Uint8Array(await binRes.arrayBuffer());
    onProgress?.(buf.byteLength, total);
  }

  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'AFLW') throw new Error(`风场数据 magic 不匹配：${magic}`);
  const hdrLen = buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24);
  const headerJson = new TextDecoder().decode(buf.subarray(8, 8 + hdrLen));
  const header = JSON.parse(headerJson) as WindHeader;

  const payloadStart = 8 + hdrLen;
  // Float16Array 尚未在所有浏览器可用，用 Uint16 视图 + 手动解码
  const u16 = new Uint16Array(
    buf.buffer.slice(buf.byteOffset + payloadStart, buf.byteOffset + buf.byteLength),
  );
  const data = decodeHalf(u16);

  const g = header.grid;
  const stridePerLevel = g.nLat * g.nLon * 4;

  return {
    header,
    data,
    grid: g,
    levels: header.levels.map((l) => l.hPa),
    steps: header.steps.map((s) => s.hour),
    stridePerLevel,
  };
}

/** 在某一层上按行列取 RGBA */
export function texelAt(field: WindField, stepIdx: number, levelIdx: number, iLat: number, iLon: number, out: Float32Array): void {
  const g = field.grid;
  const base =
    ((stepIdx * field.levels.length + levelIdx) * g.nLat + iLat) * g.nLon * 4 + iLon * 4;
  out[0] = field.data[base];
  out[1] = field.data[base + 1];
  out[2] = field.data[base + 2];
  out[3] = field.data[base + 3];
}

export type SampleOptions = {
  /** 气压层索引（可为小数，线性插值） */
  levelPos: number;
  /** 时间位置（预报步索引，可为小数） */
  stepPos: number;
};

export type WindSample = Wind & {
  /** 0..1 晴空湍流指数 */
  cat: number;
  /** 静温 K */
  tempK: number;
  /** 风速 m/s */
  speed: number;
  /** 风向（度，气象约定：风的来向） */
  direction: number;
};

const scratchA = new Float32Array(4);
const scratchB = new Float32Array(4);

/**
 * 双线性 + 层间 + 时间线性插值。这是一个热路径，不分配对象。
 */
export function sampleWind(
  field: WindField,
  lat: number,
  lon: number,
  opts: SampleOptions,
  out: WindSample = { u: 0, v: 0, cat: 0, tempK: 216, speed: 0, direction: 0 },
): WindSample {
  const g = field.grid;
  const dLat = (g.latMax - g.latMin) / (g.nLat - 1);
  const dLon = (g.lonMax - g.lonMin) / (g.nLon - 1);

  // 经度归一到 [lonMin, lonMin+360)
  let lo = (lon - g.lonMin) % 360;
  if (lo < 0) lo += 360;
  let x = lo / dLon;
  let y = (lat - g.latMin) / dLat;

  const nLonWrap = g.nLon - 1; // 末列 = 首列（360°）
  let x0 = Math.floor(x);
  const fx = x - x0;
  x0 = ((x0 % nLonWrap) + nLonWrap) % nLonWrap;
  const x1 = (x0 + 1) % nLonWrap;

  y = Math.max(0, Math.min(g.nLat - 1, y));
  let y0 = Math.floor(y);
  if (y0 > g.nLat - 2) y0 = g.nLat - 2;
  const fy = y - y0;
  const y1 = y0 + 1;

  const nLevels = field.levels.length;
  const nSteps = field.steps.length;
  const lp = Math.max(0, Math.min(nLevels - 1, opts.levelPos));
  const l0 = Math.floor(lp);
  const l1 = Math.min(nLevels - 1, l0 + 1);
  const fl = lp - l0;

  const sp = Math.max(0, Math.min(nSteps - 1, opts.stepPos));
  const s0 = Math.floor(sp);
  const s1 = Math.min(nSteps - 1, s0 + 1);
  const fs = sp - s0;

  let u = 0, v = 0, cat = 0, temp = 0;

  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;

  const layerWeight = [1 - fl, fl];
  const stepWeight = [1 - fs, fs];
  const layerIdx = [l0, l1];
  const stepIdx = [s0, s1];

  for (let a = 0; a < 2; a++) {
    const ws = stepWeight[a];
    if (ws <= 0.0001) continue;
    for (let b = 0; b < 2; b++) {
      const wl = layerWeight[b];
      if (wl <= 0.0001) continue;
      const w = ws * wl;
      const s = stepIdx[a];
      const l = layerIdx[b];

      texelAt(field, s, l, y0, x0, scratchA);
      texelAt(field, s, l, y0, x1, scratchB);
      let uu = scratchA[0] * w00 + scratchB[0] * w10;
      let vv = scratchA[1] * w00 + scratchB[1] * w10;
      let cc = scratchA[2] * w00 + scratchB[2] * w10;
      let tt = scratchA[3] * w00 + scratchB[3] * w10;

      texelAt(field, s, l, y1, x0, scratchA);
      texelAt(field, s, l, y1, x1, scratchB);
      uu += scratchA[0] * w01 + scratchB[0] * w11;
      vv += scratchA[1] * w01 + scratchB[1] * w11;
      cc += scratchA[2] * w01 + scratchB[2] * w11;
      tt += scratchA[3] * w01 + scratchB[3] * w11;

      u += uu * w;
      v += vv * w;
      cat += cc * w;
      temp += tt * w;
    }
  }

  out.u = u;
  out.v = v;
  out.cat = Math.max(0, Math.min(1, cat));
  out.tempK = temp;
  out.speed = Math.hypot(u, v);
  out.direction = (Math.atan2(-u, -v) * 180) / Math.PI;
  if (out.direction < 0) out.direction += 360;
  return out;
}

/** 找出场中最大风速，供色标自适应 */
export function fieldMaxWind(field: WindField, stepIdx: number, levelIdx: number): number {
  const g = field.grid;
  let max = 0;
  const base = (stepIdx * field.levels.length + levelIdx) * g.nLat * g.nLon * 4;
  const n = g.nLat * g.nLon * 4;
  for (let i = 0; i < n; i += 4) {
    const s = Math.hypot(field.data[base + i], field.data[base + i + 1]);
    if (s > max) max = s;
  }
  return max;
}

/** 把某步某层取出成 RGBA 交错数组（供 GPU 上传），可顺带归一化 */
export function extractLevelRGBA(
  field: WindField,
  stepIdx: number,
  levelIdx: number,
): Float32Array {
  const g = field.grid;
  const n = g.nLat * g.nLon * 4;
  const base = (stepIdx * field.levels.length + levelIdx) * n;
  return field.data.subarray(base, base + n);
}

/**
 * 气压 → 层索引（可为小数）。层序按气压降序排列（200 → 250 → 300 hPa），
 * 也就是从高空到低空；气压值越大高度越低。
 */
export function pressureToLevelPos(field: WindField, hPa: number): number {
  const lv = field.levels;
  if (!lv.length) return 0;
  if (hPa <= lv[0]) return 0; // 高于最高层，夹取
  if (hPa >= lv[lv.length - 1]) return lv.length - 1; // 低于最低层，夹取
  for (let i = 0; i < lv.length - 1; i++) {
    const a = lv[i];
    const b = lv[i + 1];
    if (hPa >= Math.min(a, b) && hPa <= Math.max(a, b)) {
      const t = (hPa - a) / (b - a); // a → b 的线性插值参数
      return i + t;
    }
  }
  return 0;
}

/** 时间（Unix 毫秒）→ 步索引（可为小数） */
export function timeToStepPos(field: WindField, timeMs: number): number {
  const times = field.header.steps.map((s) => Date.parse(s.validTime));
  if (!times.length) return 0;
  if (timeMs <= times[0]) return 0;
  if (timeMs >= times[times.length - 1]) return times.length - 1;
  for (let i = 0; i < times.length - 1; i++) {
    if (timeMs >= times[i] && timeMs <= times[i + 1]) {
      const span = times[i + 1] - times[i] || 1;
      return i + (timeMs - times[i]) / span;
    }
  }
  return 0;
}

export function stepTimes(field: WindField): number[] {
  return field.header.steps.map((s) => Date.parse(s.validTime));
}
