/**
 * 球面几何工具
 * ---------------------------------------------------------------------------
 * 坐标约定（必须与 three.js 相机手性一致，否则地球会东西镜像）：
 *
 *   x = cosφ·cosλ
 *   y = sinφ
 *   z = −cosφ·sinλ        ← 负号是关键
 *
 * 为什么是 −sin：
 *   three.js 相机看向自身的 −Z，屏幕右方向 = cross(worldUp, camBackward)。
 *   相机站在 +X 轴上（经度 0°）看向原点时，屏幕右 = (0, 0, −1)。
 *   若用 z = +sinλ，则 +90°E 的世界坐标 z = +1，与屏幕右方向反向，
 *   于是「东」被画在屏幕左侧——整个地球东西镜像。
 *   改用 −sinλ 后，+90°E → z = −1 = 屏幕右，方向正确。
 *
 * 该符号只影响「经纬 → 世界坐标」的映射，不改变任何球面几何量
 * （距离、方位角、大圆插值都在经纬空间计算，与手性无关）。
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
  return [radius * c * Math.cos(lam), radius * Math.sin(phi), -radius * c * Math.sin(lam)];
}

export function fromVec3(v: Vec3): LatLon {
  const [x, y, z] = v;
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y / r))) * RAD,
    lon: normalizeLon(Math.atan2(-z, x) * RAD),
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
 *
 * 对跖点（ω ≈ π）必须单独处理：此时 sin(ω) → 0，两个插值系数被放大到
 * 无穷，结果长度可达 1.5 倍，根本不在球面上。虽然 fromVec3 会重新归一化
 * 掩盖问题，但直接消费 Vec3 的调用方（greatCirclePath 等）会拿到假点。
 * 做法是任选一个与 a 正交的「中继点」，分两段插值。
 */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const omega = angularDistance(a, b);

  if (omega < 1e-9) return a;

  if (omega > Math.PI - 1e-7) {
    // 对跖点之间的大圆不唯一——有无穷多条，物理上没有唯一正确答案。
    // 但必须是**确定且连续**的：同一对输入每次调用得到同一条路径。
    //
    // 早期实现「绕某个垂直轴把 a 旋转 90°」得到的中继点落在极点（lat ±90），
    // 路径整个塌到极地，长度和方向都失去意义。
    //
    // 这里用「本地北向」构造中继点：把北极投影到 a 的切平面得到 d，
    // 再取 mid = normalize(a + d)。mid 必然在球面上、与 a 正交，且连续可微。
    const Y: Vec3 = [0, 1, 0];
    const ad = dot(a, Y);
    let d: Vec3 = [Y[0] - ad * a[0], Y[1] - ad * a[1], Y[2] - ad * a[2]];
    if (length(d) < 1e-6) {
      // a 本身就是极点：改用一个水平参考方向
      d = cross(a, [1, 0, 0]);
    }
    d = normalize(d);
    const mid = normalize([a[0] + d[0], a[1] + d[1], a[2] + d[2]]);

    if (t <= 0.5) return slerpUnit(a, mid, t * 2);
    return slerpUnit(mid, b, (t - 0.5) * 2);
  }

  return slerpUnit(a, b, t);
}

/** 标准 slerp，调用方保证 0 < ω < π */
function slerpUnit(a: Vec3, b: Vec3, t: number): Vec3 {
  const omega = angularDistance(a, b);
  const so = Math.sin(omega);
  if (Math.abs(so) < 1e-12) return a;
  const s0 = Math.sin((1 - t) * omega) / so;
  const s1 = Math.sin(t * omega) / so;
  return [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1];
}

/** 球面角距（弧度），haversine 数值稳定版 */
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
 *
 * 符号必须与 toVec3 的 z = −sinλ 约定配套。逐项验算（lat=30°, lon=100°）：
 *   ∂p/∂λ ∝ (−sinλ, 0, −cosλ) 为「经度增大方向」
 *   cross(+Y, up) = (cosλ, 0, −sinλ) 与之同向 → 这是正确的 east
 *   cross(up, east) 再给出 north
 * 若把 east 写成 cross(up, +Y)，风的东向分量会整体反向，
 * 顺风就被算成逆风——物理结论会整个翻过来。
 */
export function tangentBasis(p: Vec3): { east: Vec3; north: Vec3; up: Vec3 } {
  const up = normalize(p);
  let east = cross([0, 1, 0], up);
  if (length(east) < 1e-9) {
    // 极点：经度退化，任取一个与 up 正交的切向，保证基仍然正交
    east = [0, 0, -1];
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

/* ==========================================================================
   恒向线（Rhumb line / Loxodrome）
   --------------------------------------------------------------------------
   恒定航向的航线。它在 Mercator 投影上是一条直线，是海图时代的产物。
   与大圆的关系：赤道上两者重合；其他纬度上恒向线总是更长，
   高纬长航程时差距可达 30% 以上（这就是大圆航线的价值）。

   注意：必须用 **Mercator 方位角**而不是大圆的 initialBearing。
   JFK→LHR 两者相差约 26°（51.4° vs 77.9°），
   用错会让「恒向线」被画成一条错误的螺旋。
   ========================================================================== */

/** Mercator 投影的等增长度 ψ = ln(tan(π/4 + φ/2)) */
export function mercatorPsi(latDeg: number): number {
  const φ = clamp(latDeg, -89.9999, 89.9999) * DEG;
  return Math.log(Math.tan(Math.PI / 4 + φ / 2));
}

export type RhumbLine = {
  /** 恒定航向（度，正北 0，顺时针） */
  bearing: number;
  /** 恒定航向的弧度值（用于反向推进） */
  bearingRad: number;
  /** 总长度（米） */
  distance: number;
  from: LatLon;
  to: LatLon;
};

/**
 * 计算两点间恒向线的方位角与长度。
 *
 * 使用标准公式：
 *   Δψ = ψ₂ − ψ₁
 *   q  = Δφ / Δψ            （Δψ → 0 时取 cos φ₁）
 *   s  = √(Δφ² + q²Δλ²) · R
 *   θ  = atan2(Δλ, Δψ)
 *
 * 与方向无关：交换起终点得到相同长度、相差 180° 的航向。
 */
export function rhumbLine(a: LatLon, b: LatLon): RhumbLine {
  const φ1 = a.lat * DEG;
  const φ2 = b.lat * DEG;
  const λ1 = a.lon * DEG;
  const λ2 = b.lon * DEG;

  // 经差取最短路径（-180..180），保证跨日界线时走短路
  let Δλ = λ2 - λ1;
  while (Δλ > Math.PI) Δλ -= 2 * Math.PI;
  while (Δλ < -Math.PI) Δλ += 2 * Math.PI;

  const Δφ = φ2 - φ1;
  const Δψ = mercatorPsi(b.lat) - mercatorPsi(a.lat);

  // Δψ 趋零时 q → cos φ（赤道附近或纯东西向）
  const q = Math.abs(Δψ) > 1e-12 ? Δφ / Δψ : Math.cos(φ1);

  const distance = Math.hypot(Δφ, q * Δλ) * EARTH_R_M;
  const bearingRad = Math.atan2(Δλ, Δψ);

  return {
    bearing: (bearingRad * RAD + 360) % 360,
    bearingRad,
    distance,
    from: a,
    to: b,
  };
}

/** 恒向线插值：t ∈ [0,1] 从 a 走到 b */
export function rhumbPoint(a: LatLon, b: LatLon, t: number): LatLon {
  const λ1 = a.lon * DEG;

  let Δλ = b.lon * DEG - λ1;
  while (Δλ > Math.PI) Δλ -= 2 * Math.PI;
  while (Δλ < -Math.PI) Δλ += 2 * Math.PI;

  const ψ1 = mercatorPsi(a.lat);
  const ψ2 = mercatorPsi(b.lat);
  const ψ = ψ1 + (ψ2 - ψ1) * t;

  // 由 ψ 反解纬度
  const φ = 2 * Math.atan(Math.exp(ψ)) - Math.PI / 2;
  const λ = λ1 + Δλ * t;

  return { lat: φ * RAD, lon: normalizeLon(λ * RAD) };
}

/** 生成恒向线航路点（含两端点） */
export function rhumbPath(a: LatLon, b: LatLon, steps: number): LatLon[] {
  const n = Math.max(1, Math.floor(steps));
  const out: LatLon[] = [];
  for (let i = 0; i <= n; i++) out.push(i === 0 ? a : i === n ? b : rhumbPoint(a, b, i / n));
  return out;
}

/** 方位角（度）转单位切向（0=正北，90=正东） */
export function bearingToUV(bearingDeg: number): { east: number; north: number } {
  const r = bearingDeg * DEG;
  return { east: Math.sin(r), north: Math.cos(r) };
}

export function uvToBearing(u: number, v: number): number {
  return (Math.atan2(u, v) * RAD + 360) % 360;
}

/**
 * 把值夹到 [lo, hi]。
 *
 * NaN 必须显式处理：`x < lo ? lo : x > hi ? hi : x` 对 NaN 三个分支都是
 * false，会原样返回 NaN，于是「夹取」变成了 NaN 的搬运工。
 * 这里把 NaN 收束到 lo，让下游拿到一个可解释的边界值。
 */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? lo : x > 0 ? hi : lo;
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
