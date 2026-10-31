/**
 * 风场纹理管理
 * ---------------------------------------------------------------------------
 * 把 AFLW 数据在当前「高度层 × 预报时效」上做双线性插值，打包成 RGBA16F
 * 的 DataTexture 供 GPU 采样：
 *   R = u (m/s)   G = v (m/s)   B = CAT 指数   A = 风速 (m/s)
 *
 * 用半浮点而不是浮点：WebGL2 下 RGBA16F 支持线性过滤是核心规范，
 * 不需要 OES_texture_float_linear；精度 2^-11 对 0-120 m/s 的风够用。
 */

import * as THREE from 'three';
import type { WindField } from '../data/windField';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 → float16 位模式 */
export function toHalf(val: number): number {
  f32[0] = val;
  const x = u32[0];
  const sign = (x >>> 31) & 0x1;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;

  if (exp === 0xff) {
    // Inf / NaN
    return (sign << 15) | 0x7c00 | (mant ? 0x200 : 0);
  }
  let e = exp - 127 + 15;
  if (e >= 0x1f) return (sign << 15) | 0x7c00; // 溢出 → Inf
  if (e <= 0) {
    if (e < -10) return sign << 15;
    mant |= 0x800000;
    const shift = 14 - e;
    const m = mant >>> shift;
    // 就近舍入
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    return (sign << 15) | (m + (rem >= half ? 1 : 0));
  }
  const m16 = mant >>> 13;
  const rem = mant & 0x1fff;
  let out = (sign << 15) | (e << 10) | m16;
  if (rem > 0x1000 || (rem === 0x1000 && (m16 & 1))) out += 1;
  return out;
}

export type GridFrame = {
  u: Float32Array;
  v: Float32Array;
  cat: Float32Array;
  speed: Float32Array;
  nLat: number;
  nLon: number;
};

/**
 * 在整张网格上做「层间 + 时间」插值，得到当前时刻的一帧。
 * 这是风场数据流里唯一的重计算，只在用户改变高度/时间时触发。
 */
export function buildGridFrame(
  field: WindField,
  levelPos: number,
  stepPos: number,
  out?: GridFrame,
): GridFrame {
  const g = field.grid;
  const nLat = g.nLat;
  const nLon = g.nLon;
  const n = nLat * nLon;

  const frame: GridFrame = out ?? {
    u: new Float32Array(n),
    v: new Float32Array(n),
    cat: new Float32Array(n),
    speed: new Float32Array(n),
    nLat,
    nLon,
  };

  const nLevels = field.levels.length;
  const nSteps = field.steps.length;
  const lp = Math.max(0, Math.min(nLevels - 1, levelPos));
  const l0 = Math.floor(lp);
  const l1 = Math.min(nLevels - 1, l0 + 1);
  const wl = lp - l0;

  const sp = Math.max(0, Math.min(nSteps - 1, stepPos));
  const s0 = Math.floor(sp);
  const s1 = Math.min(nSteps - 1, s0 + 1);
  const ws = sp - s0;

  const stride = field.stridePerLevel;
  const base00 = (s0 * nLevels + l0) * stride;
  const base01 = (s0 * nLevels + l1) * stride;
  const base10 = (s1 * nLevels + l0) * stride;
  const base11 = (s1 * nLevels + l1) * stride;

  const w00 = (1 - ws) * (1 - wl);
  const w01 = (1 - ws) * wl;
  const w10 = ws * (1 - wl);
  const w11 = ws * wl;

  const d = field.data;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const u =
      d[base00 + o] * w00 + d[base01 + o] * w01 + d[base10 + o] * w10 + d[base11 + o] * w11;
    const v =
      d[base00 + o + 1] * w00 +
      d[base01 + o + 1] * w01 +
      d[base10 + o + 1] * w10 +
      d[base11 + o + 1] * w11;
    const cat =
      d[base00 + o + 2] * w00 +
      d[base01 + o + 2] * w01 +
      d[base10 + o + 2] * w10 +
      d[base11 + o + 2] * w11;
    frame.u[i] = u;
    frame.v[i] = v;
    frame.cat[i] = cat;
    frame.speed[i] = Math.hypot(u, v);
  }
  return frame;
}

/** 把一帧打包成 RGBA16F 半浮点数组 */
export function frameToHalfRGBA(frame: GridFrame): Uint16Array {
  const n = frame.nLat * frame.nLon;
  const out = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[o] = toHalf(frame.u[i]);
    out[o + 1] = toHalf(frame.v[i]);
    out[o + 2] = toHalf(frame.cat[i]);
    out[o + 3] = toHalf(frame.speed[i]);
  }
  return out;
}

export function createWindTexture(field: WindField): {
  texture: THREE.DataTexture;
  update: (levelPos: number, stepPos: number) => GridFrame;
  dispose: () => void;
} {
  const g = field.grid;
  const empty = new Uint16Array(g.nLat * g.nLon * 4);

  const texture = new THREE.DataTexture(
    empty,
    g.nLon,
    g.nLat,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  let cachedFrame: GridFrame | undefined;

  const update = (levelPos: number, stepPos: number): GridFrame => {
    cachedFrame = buildGridFrame(field, levelPos, stepPos, cachedFrame);
    const half = frameToHalfRGBA(cachedFrame);
    const img = texture.image as unknown as { data: Uint16Array; width: number; height: number };
    img.data.set(half);
    texture.needsUpdate = true;
    return cachedFrame;
  };

  return {
    texture,
    update,
    dispose: () => texture.dispose(),
  };
}

/** 风速 LUT：256×1 RGBA8 */
export function createLutTexture(ramp: Array<{ t: number; color: [number, number, number] }>): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let col = ramp[ramp.length - 1].color;
    for (let k = 0; k < ramp.length - 1; k++) {
      const a = ramp[k];
      const b = ramp[k + 1];
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t || 1);
        col = [
          a.color[0] + (b.color[0] - a.color[0]) * f,
          a.color[1] + (b.color[1] - a.color[1]) * f,
          a.color[2] + (b.color[2] - a.color[2]) * f,
        ];
        break;
      }
    }
    data[i * 4] = Math.round(col[0] * 255);
    data[i * 4 + 1] = Math.round(col[1] * 255);
    data[i * 4 + 2] = Math.round(col[2] * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
