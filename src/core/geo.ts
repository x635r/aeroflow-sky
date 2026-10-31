/**
 * 球面几何工具
 * ---------------------------------------------------------------------------
 * 全部使用「纬度/经度（度）→ 单位球面向量」的约定：
 *   x = cosφ·cosλ, y = sinφ, z = cosφ·sinλ
 * 与 three.js 的 Y-up 世界坐标一致，因此向量可直接喂给渲染层。
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
/** 地球平均半径（米），航空常用值 */
export const EARTH_R_M = 6_371_008.8;
/** 英尺 → 米 */
export const FT_TO_M = 0.3048;

export type Vec3 = readonly [number, number, number];
export type LatLon = { lat: number; lon: number };

export function normalizeLon(lon: number): number {
  let l = lon % 360;
  if (l > 180) l -= 360;
  if (l < -180) l += 360;
  return l;
}

export function toVec3(lat: number, lon: number, radius = 1): Vec3 {
  const phi = lat * DEG;
  const lam = lon * DEG;
  const c = Math.cos(phi);
  return [radius * c * Math.cos(lam), radius * Math.sin(phi), radius * c * Math.sin(lam)];
}

export function fromVec3(v: Vec3): LatLon {
  const [x, y, z] = v;
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y / r))) * RAD,
    lon: normalizeLon(Math.atan2(z, x) * RAD),
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** 球面角距（弧度），haversine 数值稳定版 */
export function angularDistance(a: Vec3, b: Vec3): number {
  const d = dot(a, b);
  return Math.atan2(length(cross(a, b)), d);
}

/** 两点大圆距离（米） */
export function greatCircleDistance(a: LatLon, b: LatLon): number {
  return angularDistance(toVec3(a.lat, a.lon), toVec3(b.lat, b.lon)) * EARTH_R_M;
}

/**
 * 球面线性插值 (slerp)，t ∈ [0,1]。用于生成大圆航路点。
 */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const omega = angularDistance(a, b);
  if (omega < 1e-9) return a;
  const so = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / so;
  const s1 = Math.sin(t * omega) / so;
  return [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1];
}

/**
 * 大圆航线的初始方位角（度，正北为 0，顺时针）。
 */
export function initialBearing(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * DEG;
  const φ2 = b.lat * DEG;
  const Δλ = (b.lon - a.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/**
 * 沿大圆从 a 到 b 的方位角（在点 a 处指向 b 的切向单位向量，纬度经度空间）。
 */
export function bearingAt(a: Vec3, b: Vec3): number {
  const la = fromVec3(a);
  const lb = fromVec3(b);
  return initialBearing(la, lb);
}

/**
 * 在球面点 p 处的局部切平面基：east 指向东，north 指向北。
 */
export function tangentBasis(p: Vec3): { east: Vec3; north: Vec3; up: Vec3 } {
  const up = normalize(p);
  // 北极方向在世界 +Y
  let east = cross([0, 1, 0], up);
  if (length(east) < 1e-9) {
    east = [1, 0, 0]; // 极点处任取
  }
  east = normalize(east);
  const north = normalize(cross(up, east));
  return { east, north, up };
}

/**
 * 把「东向分量 u、北向分量 v」的风矢量合成到世界坐标系切平面向量。
 */
export function windToWorld(p: Vec3, u: number, v: number): Vec3 {
  const { east, north } = tangentBasis(p);
  return [east[0] * u + north[0] * v, east[1] * u + north[1] * v, east[2] * u + north[2] * v];
}

/**
 * 生成大圆航路点。
 * @param steps 分段数（点数 = steps + 1）
 */
export function greatCirclePath(a: LatLon, b: LatLon, steps: number): Vec3[] {
  const va = toVec3(a.lat, a.lon);
  const vb = toVec3(b.lat, b.lon);
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) out.push(slerp(va, vb, i / steps));
  return out;
}

/**
 * 大圆航线相对于等角航线的最大纬度偏移（度），用于量化「大圆偏角」。
 * 正值表示大圆向北拱起。北半球东西向航线通常明显北拱。
 */
export function greatCircleBulge(a: LatLon, b: LatLon, samples = 128): number {
  let maxDev = 0;
  let signedDev = 0;
  const dl = normalizeLon(b.lon - a.lon);
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const p = fromVec3(slerp(toVec3(a.lat, a.lon), toVec3(b.lat, b.lon), t));
    const rhumbLat = a.lat + (b.lat - a.lat) * t;
    void dl;
    const dev = p.lat - rhumbLat;
    if (Math.abs(dev) > maxDev) {
      maxDev = Math.abs(dev);
      signedDev = dev;
    }
  }
  return signedDev;
}

/** 方位角（度）转单位切向（东为 0，逆时针？此处约定：0=正北，90=正东） */
export function bearingToUV(bearingDeg: number): { east: number; north: number } {
  const r = bearingDeg * DEG;
  return { east: Math.sin(r), north: Math.cos(r) };
}

export function uvToBearing(u: number, v: number): number {
  return (Math.atan2(u, v) * RAD + 360) % 360;
}

/** 把长度夹到 [lo, hi] */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 把 x 从 [inLo,inHi] 映射到 [outLo,outHi] 并夹取 */
export function remap(x: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  const t = clamp((x - inLo) / (inHi - inLo || 1), 0, 1);
  return outLo + (outHi - outLo) * t;
}

/** 平滑阶跃 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}
