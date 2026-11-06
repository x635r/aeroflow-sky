/**
 * 航路推演引擎
 * ---------------------------------------------------------------------------
 * 回答产品的核心问题：「同一条航线、同一机型，向东飞和向西飞到底差多少？」
 *
 * 三个量的定义必须严格区分，否则整个叙事就站不住：
 *
 *   1. 大圆最短路线 (Great Circle)
 *      球面上两点间测地线，纯几何最短。不考虑风。
 *
 *   2. 借风最快路线 (Wind-Optimal)
 *      在沿大圆航线展开的「横向槽」上做动态规划：
 *      每段用真实风场求地速，最小化总飞行时间。
 *      结果通常比大圆更长，但因为吃到顺风而更快——
 *      这正是跨洋航班的真实做法（北大西洋的 NAT 航路每天随急流摆动）。
 *
 *   3. 等角航线 (Rhumb Line)
 *      恒定航向的航迹，是海图时代的产物，作为"为什么不用它"的反面对照。
 *
 * 所有时间都用「地速 = 真空速 + 风」的地速积分求得，没有任何魔数。
 */

import {
  EARTH_R_M,
  type LatLon,
  toVec3,
  fromVec3,
  slerp,
  greatCircleDistance,
  initialBearing,
  rhumbLine,
  rhumbPath,
  bearingToUV,
  normalizeLon,
  clamp,
  DEG,
  RAD,
} from '../core/geo';
import {
  solveWindTriangle,
  type AircraftProfile,
  machToTas,
} from '../core/atmos';
import { sampleWind, type WindField, type WindSample, pressureToLevelPos } from '../data/windField';

export type RoutePoint = {
  lat: number;
  lon: number;
  /** 累计距离（米） */
  distance: number;
  /** 该点的地速（m/s） */
  groundSpeed: number;
  /** 该点的真空速（m/s） */
  tas: number;
  /** 航迹角（度） */
  track: number;
  /** 顺风分量（m/s，正为顺风） */
  windAlong: number;
  /** 侧风分量（m/s） */
  windCross: number;
  /** 风速（m/s） */
  windSpeed: number;
  /** 风向（度，来向） */
  windDir: number;
  /** 晴空湍流指数 0..1 */
  cat: number;
  /** 静温 K */
  tempK: number;
};

export type RouteResult = {
  kind: 'greatcircle' | 'windoptimal' | 'rhumb';
  points: RoutePoint[];
  /** 总距离（米） */
  distance: number;
  /** 总时间（秒） */
  duration: number;
  /** 平均地速（m/s） */
  avgGroundSpeed: number;
  /** 平均顺风分量（m/s） */
  avgWindAlong: number;
  /** 最大风速点 */
  maxWind: number;
  /** 最大 CAT */
  maxCat: number;
  /** CAT 超过阈值的航段占比 */
  catFraction: number;
  /** 相对大圆的偏离（度，最大纬度/横向偏差） */
  deviationDeg: number;
  /** 相对大圆多飞的距离（米） */
  extraDistance: number;
  /**
   * 因风太强而物理上飞不出来的航段数。
   *
   * 非零时 duration 不代表"实际飞行时间"——它混合了
   * "这段路需要 1 m/s 才是真实代价"的占位值。UI 必须据此
   * 显示警告而不是给出一个 161 小时的时间。
   */
  infeasibleLegs: number;
};

export type PlanContext = {
  field: WindField;
  /** 气压层（hPa） */
  pressureHpa: number;
  /** 时间位置（步索引，可为小数） */
  stepPos: number;
  aircraft: AircraftProfile;
  /** 巡航马赫 */
  mach: number;
};

/** 沿大圆的横向偏移位置（米），在给定点处垂直于航迹移动 */
function offsetPoint(p: LatLon, bearingDeg: number, distM: number): LatLon {
  const angular = distM / EARTH_R_M;
  const φ1 = p.lat * DEG;
  const λ1 = p.lon * DEG;
  const θ = ((bearingDeg + 90) % 360) * DEG; // 右偏

  const sinφ2 = Math.sin(φ1) * Math.cos(angular) + Math.cos(φ1) * Math.sin(angular) * Math.cos(θ);
  const φ2 = Math.asin(clamp(sinφ2, -1, 1));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(angular) * Math.cos(φ1),
      Math.cos(angular) - Math.sin(φ1) * sinφ2,
    );

  return { lat: φ2 * RAD, lon: normalizeLon(λ2 * RAD) };
}

/** 建一个可复用的采样上下文，避免每点分配 */
function makeSampler(ctx: PlanContext) {
  const levelPos = pressureToLevelPos(ctx.field, ctx.pressureHpa);
  const sample: WindSample = { u: 0, v: 0, cat: 0, tempK: 216, speed: 0, direction: 0 };

  return {
    levelPos,
    at(lat: number, lon: number): WindSample {
      return sampleWind(ctx.field, lat, lon, { levelPos, stepPos: ctx.stepPos }, sample);
    },
  };
}

/**
 * 沿一条折线（经纬点序列）积分飞行时间。
 * 每段用中点风，段内视为匀速——积分误差小且完全可复现。
 *
 * 语义约定（务必保持）：
 *   points[i].distance      = 起点到第 i 点的**累计**距离，points[0] 恒为 0
 *   points[i].groundSpeed   = 第 i 点 → 第 i+1 点这一段的平均地速
 *   末点的 groundSpeed 沿用最后一段，避免 UI 显示 0
 *
 * 早期版本先累加再 push，导致 points[0].distance 等于首段长度（非 0），
 * summarize 用相邻点距离差求时长时整段漏掉首段，时长系统性偏低 2–3%。
 */
function integrateLegs(
  ctx: PlanContext,
  coords: LatLon[],
  segmentTargetDeg = 36,
): RoutePoint[] {
  const sampler = makeSampler(ctx);
  const out: RoutePoint[] = [];

  // 先按目标角度分辨率细分，保证剖面图与 CAT 采样足够密
  const dense: LatLon[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segAngle = greatCircleDistance(a, b) / EARTH_R_M;
    const n = Math.max(1, Math.ceil((segAngle * RAD) / segmentTargetDeg));
    const va = toVec3(a.lat, a.lon);
    const vb = toVec3(b.lat, b.lon);
    for (let k = 0; k < n; k++) {
      const v = slerp(va, vb, k / n);
      dense.push(fromVec3(v));
    }
  }
  dense.push(coords[coords.length - 1]);

  let distance = 0;
  // 上一段的飞行参数，用于给末点填一个合理值
  let lastLeg = { gs: 0, tas: 0, along: 0, cross: 0, track: 0 };

  for (let i = 0; i < dense.length; i++) {
    const p = dense[i];
    const isLast = i >= dense.length - 1;

    let leg = lastLeg;

    if (!isLast) {
      const next = dense[i + 1];
      const track = initialBearing(p, next);
      const mid = fromVec3(slerp(toVec3(p.lat, p.lon), toVec3(next.lat, next.lon), 0.5));
      const w = sampler.at(mid.lat, mid.lon);
      const tas = machToTas(ctx.mach, w.tempK);
      const tri = solveWindTriangle(track, tas, w);
      if (tri.infeasible) {
        // 该段风太强、物理上飞不出来。
        //
        // 这里**不能 continue**：continue 会连下面的距离累加一起跳过，
        // 于是整条航线的距离被"打折"（实测 6672km 只积出 6116km，少 8%），
        // 时长同比例偏短——而且这种错误完全静默，界面上看不出来。
        //
        // 正确做法：保留几何距离（路还是要走这些公里），
        // 但把该段地速记为「极度不利」，让时长如实反映飞不动的代价。
        leg = {
          gs: 1,                      // 贴地下限：代表实际不可达
          tas,
          along: -tri.headwindComponent,
          cross: tri.crosswindComponent,
          track,
        };
        lastLeg = leg;
        void tri.groundSpeed;
      } else {
        leg = {
          gs: tri.groundSpeed,
          tas,
          along: -tri.headwindComponent,
          cross: tri.crosswindComponent,
          track,
        };
        lastLeg = leg;
      }
    }

    const w = sampler.at(p.lat, p.lon);
    out.push({
      lat: p.lat,
      lon: p.lon,
      distance,
      groundSpeed: leg.gs,
      tas: leg.tas,
      track: leg.track,
      windAlong: leg.along,
      windCross: leg.cross,
      windSpeed: w.speed,
      windDir: w.direction,
      cat: w.cat,
      tempK: w.tempK,
    });

    // 累加的是「本点 → 下一点」的距离
    if (!isLast) {
      distance += greatCircleDistance(p, dense[i + 1]);
    }
  }

  return out;
}

/* ==========================================================================
   CAT 湍流等级：单一事实来源
   --------------------------------------------------------------------------
   早期版本在 6 个文件里用了 6 个不同的阈值（0.25 / 0.3 / 0.42 / 0.45 / 0.5 / 0.55），
   于是同一个航段的「湍流占比」在两个面板上给出不同数字。
   所有消费方（渲染、面板、图例）必须引用这里的常量。
   ========================================================================== */
export const CAT_LEVELS = {
  /** 低于此值视为背景噪声（对应 Ellrod TI1 的分位归一结果） */
  light: 0.42,
  moderate: 0.55,
  severe: 0.72,
} as const;

/** 计入「受影响航段」统计的门槛 */
export const CAT_AFFECTED_THRESHOLD = CAT_LEVELS.light;

export function catLevelOf(index: number): 'smooth' | 'light' | 'moderate' | 'severe' {
  // NaN 与任何数比较都是 false，会一路落到最后一个分支被判成 severe。
  // 未知不等于最危险，所以 NaN 显式归为 smooth。
  // 注意只拦 NaN 不拦 ±Infinity：正无穷确实超出阈值，按 severe 处理是正确的。
  if (Number.isNaN(index)) return 'smooth';
  if (index < CAT_LEVELS.light) return 'smooth';
  if (index < CAT_LEVELS.moderate) return 'light';
  if (index < CAT_LEVELS.severe) return 'moderate';
  return 'severe';
}

function summarize(
  kind: RouteResult['kind'],
  points: RoutePoint[],
  referenceDistance: number,
  deviationDeg = 0,
): RouteResult {
  const distance = points.length ? points[points.length - 1].distance : 0;

  // 第 i 段的地速就是 points[i].groundSpeed（integrateLegs 的约定）
  let duration = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    const d = q.distance - p.distance;
    duration += d / Math.max(p.groundSpeed, 1);
  }

  const avgGs = duration > 0 ? distance / duration : 0;

  let sumAlong = 0;
  let maxWind = 0;
  let maxCat = 0;
  // 距离加权的湍流航程，比点数加权更符合「飞多久会颠」的直觉
  let catDist = 0;
  // 地速被压到 1 m/s 的点视为"飞不出来"的航段
  let infeasibleLegs = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    sumAlong += p.windAlong;
    if (p.windSpeed > maxWind) maxWind = p.windSpeed;
    if (Number.isFinite(p.cat) && p.cat > maxCat) maxCat = p.cat;
    if (i < points.length - 1 && catLevelOf(p.cat) !== 'smooth') {
      catDist += points[i + 1].distance - p.distance;
    }
    if (i < points.length - 1 && p.groundSpeed <= 1.5) infeasibleLegs++;
  }
  return {
    kind,
    points,
    distance,
    duration,
    avgGroundSpeed: avgGs,
    avgWindAlong: points.length ? sumAlong / points.length : 0,
    maxWind,
    maxCat,
    catFraction: distance > 0 ? catDist / distance : 0,
    deviationDeg,
    extraDistance: distance - referenceDistance,
    infeasibleLegs,
  };
}

/** 纯大圆航线（不加风） */
export function planGreatCircle(ctx: PlanContext, from: LatLon, to: LatLon): RouteResult {
  const va = toVec3(from.lat, from.lon);
  const vb = toVec3(to.lat, to.lon);
  const coords: LatLon[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) coords.push(fromVec3(slerp(va, vb, i / n)));
  const points = integrateLegs(ctx, coords);
  // 大圆就是基准本身，extraDistance 必须为 0（传 0 会得到整条航线长度）
  return summarize('greatcircle', points, greatCircleDistance(from, to));
}

/**
 * 恒向线（等角航线 / rhumb line）。
 *
 * 恒定航向，在 Mercator 投影上是一条直线。作为「为什么不走它」的反面对照：
 * 长航程时它比大圆长 10–30%，高纬更明显。
 *
 * 早期版本有三个独立错误，叠加后给出的是一条
 * 「错误航向的螺旋 + 末尾大圆瞬移」，JFK–LHR 报 7560 km（真值 5758），
 * 且正反两向长度不等。现在直接用 Mercator 插值，长度由解析公式给出。
 */
export function planRhumb(ctx: PlanContext, from: LatLon, to: LatLon): RouteResult {
  const line = rhumbLine(from, to);
  // 满足 36°/段 的细分密度，与 integrateLegs 的默认分辨率一致
  const steps = Math.max(12, Math.ceil(line.distance / EARTH_R_M / ((36 * Math.PI) / 180)));
  const coords = rhumbPath(from, to, Math.min(steps, 96));
  const points = integrateLegs(ctx, coords);
  return summarize('rhumb', points, greatCircleDistance(from, to));
}

export type WindOptimalOptions = {
  /** 横向搜索半宽（公里）。跨洋航线用 700 左右足够吃到急流。 */
  corridorKm?: number;
  /** 横向离散点数（强制为奇数，保证中心列恰好是零偏移） */
  offsets?: number;
  /** 沿航路站数 */
  stations?: number;
  /** 横向位移惩罚（秒 / 公里）。抑制逐站来回横跳的锯齿。 */
  smoothness?: number;
};

/**
 * 借风最快航线：沿大圆展开横向槽，做动态规划。
 *
 * 为什么用 DP 而不是 Dijkstra on grid：
 *   航线本质是「单向前进」，沿航迹方向的推进是单调的，
 *   所以可以按站分层，复杂度 O(N·M²) 而不是全图搜索。
 *   34 站 × 19 横向槽 → 约 1.1 万次风场采样，单次 <50ms，可实时拖动拖动。
 *
 * 不变量：走廊宽度为 0 时结果必须与大圆完全一致。
 * 这条性质是「借风收益」可信的前提——若 DP 在大圆本身上就能"省"出时间，
 * 那省下的只是离散化误差，不是风。
 */
export function planWindOptimal(
  ctx: PlanContext,
  from: LatLon,
  to: LatLon,
  opts: WindOptimalOptions = {},
): RouteResult {
  const corridorKm = Math.max(0, opts.corridorKm ?? 700);
  // 强制奇数：偶数个槽位时不存在恰好零偏移的列，DP 的可行解集合里
  // 就不含大圆，会凭空"优化"出几十公里偏移和几分钟收益。
  const requestedM = Math.max(3, Math.floor(opts.offsets ?? 21));
  const M = requestedM % 2 === 0 ? requestedM + 1 : requestedM;
  const N = Math.max(2, Math.floor(opts.stations ?? 40));

  // 单位：秒 / 公里「转向幅度」。
  // 因为只惩罚方向反转（见 turnPenalty），持续的同向绕飞不收费，
  // 所以这个值要比一阶惩罚时大得多才有效：横跳 160 km 罚约 400 s，
  // 与一次真绕飞可能省下的数百秒同量级。
  const smooth = opts.smoothness ?? 2.5;

  const va = toVec3(from.lat, from.lon);
  const vb = toVec3(to.lat, to.lon);
  const center = (M - 1) / 2;

  // 以中心为零点构造，保证 offsetsKm[center] === 0 恒成立
  const offsetsKm: number[] = [];
  for (let j = 0; j < M; j++) {
    offsetsKm.push((corridorKm * (j - center)) / center);
  }

  const sampler = makeSampler(ctx);

  // 站点位置与基准航迹角
  type Station = { base: LatLon; track: number; cand: LatLon[] };
  const stations: Station[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const v = slerp(va, vb, t);
    const base = fromVec3(v);
    const ahead = fromVec3(slerp(va, vb, Math.min(1, t + 0.02)));
    const track = initialBearing(base, ahead);
    const cand: LatLon[] = [];
    for (let j = 0; j < M; j++) {
      if (i === 0 || i === N) {
        cand.push(j === center ? base : { lat: NaN, lon: NaN });
      } else {
        cand.push(offsetPoint(base, track, offsetsKm[j] * 1000));
      }
    }
    stations.push({ base, track, cand });
  }
  // 起终点只允许居中（M 已强制为奇数，center 是整数）
  const centerIdx = center;
  for (let j = 0; j < M; j++) {
    if (j !== centerIdx) {
      stations[0].cand[j] = { lat: NaN, lon: NaN };
      stations[N].cand[j] = { lat: NaN, lon: NaN };
    }
  }
  stations[0].cand[centerIdx] = from;
  stations[N].cand[centerIdx] = to;

  const INF = Number.POSITIVE_INFINITY;
  const cost: Float64Array[] = [];
  const fromIdx: Int16Array[] = [];
  for (let i = 0; i <= N; i++) {
    cost.push(new Float64Array(M).fill(INF));
    fromIdx.push(new Int16Array(M).fill(-1));
  }
  cost[0][centerIdx] = 0;

  /**
   * 平滑处理：两阶段，而不是把转向罚塞进 DP。
   *
   * 要判断「转向」需要 (i, j, 上一站) 三维状态，复杂度变 O(N·M³)。
   * M=19、N=34 时实测单次推演从 ~400ms 涨到 ~1.8s，拖动滑块会明显卡顿。
   *
   * 所以改成一阶段纯时间最优 DP（O(N·M²)），二阶段对折线做逐站局部重优化：
   * 每站只在能降低「时间 + 转向罚」时才移动，单站 O(M)，总共 O(N²·M)。
   * 转向罚只罚方向反转——持续同向绕飞免费，来回横跳才收费。
   */
  const turnPenalty = (prevDelta: number, delta: number): number =>
    prevDelta !== 0 && delta !== 0 && prevDelta * delta < 0
      ? Math.min(Math.abs(prevDelta), Math.abs(delta)) * smooth
      : 0;

  const legTime = (a: LatLon, b: LatLon): number => {
    const dist = greatCircleDistance(a, b);
    if (dist < 1) return INF;
    const track = initialBearing(a, b);
    const mid = fromVec3(slerp(toVec3(a.lat, a.lon), toVec3(b.lat, b.lon), 0.5));
    const w = sampler.at(mid.lat, mid.lon);
    const tas = machToTas(ctx.mach, w.tempK);
    const tri = solveWindTriangle(track, tas, w);
    if (tri.infeasible) return INF;
    return dist / tri.groundSpeed;
  };

  // ---- 一阶段：纯飞行时间最优 ----
  for (let i = 0; i < N; i++) {
    const cur = stations[i];
    const nxt = stations[i + 1];
    for (let j = 0; j < M; j++) {
      const c0 = cost[i][j];
      if (!Number.isFinite(c0)) continue;
      const p = cur.cand[j];
      for (let k = 0; k < M; k++) {
        const q = nxt.cand[k];
        if (!Number.isFinite(q.lat)) continue;
        const t = legTime(p, q);
        if (!Number.isFinite(t)) continue;
        const total = c0 + t;
        if (total < cost[i + 1][k]) {
          cost[i + 1][k] = total;
          fromIdx[i + 1][k] = j;
        }
      }
    }
  }

  let bestK = -1;
  let bestCost = INF;
  for (let j = 0; j < M; j++) {
    if (cost[N][j] < bestCost) {
      bestCost = cost[N][j];
      bestK = j;
    }
  }

  const pathIdx: number[] = [];
  let jj = bestK;
  for (let i = N; i >= 0; i--) {
    pathIdx.push(jj);
    if (i === 0) break;
    const pv = fromIdx[i][jj];
    jj = pv < 0 ? jj : pv;
  }
  pathIdx.reverse();

  if (pathIdx.length < 2 || !Number.isFinite(bestCost)) {
    return planGreatCircle(ctx, from, to);
  }

  // ---- 二阶段：逐站局部重优化，消除锯齿 ----
  const totalCostAt = (i: number): number => {
    const a = stations[i - 1].cand[pathIdx[i - 1]];
    const m = stations[i].cand[pathIdx[i]];
    const b = stations[i + 1].cand[pathIdx[i + 1]];
    const t1 = legTime(a, m);
    const t2 = legTime(m, b);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return INF;
    const dPrev = offsetsKm[pathIdx[i]] - offsetsKm[pathIdx[i - 1]];
    const dNext = offsetsKm[pathIdx[i + 1]] - offsetsKm[pathIdx[i]];
    return t1 + t2 + turnPenalty(dPrev, dNext);
  };

  if (smooth > 0) {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let i = 1; i < N; i++) {
        const baseline = totalCostAt(i);
        if (!Number.isFinite(baseline)) continue;
        const keep = pathIdx[i];
        let bestC = keep;
        let bestVal = baseline;
        const a = stations[i - 1].cand[pathIdx[i - 1]];
        const b = stations[i + 1].cand[pathIdx[i + 1]];
        for (let c = 0; c < M; c++) {
          if (c === keep) continue;
          const mid = stations[i].cand[c];
          if (!Number.isFinite(mid.lat)) continue;
          const t1 = legTime(a, mid);
          const t2 = legTime(mid, b);
          if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
          const dPrev = offsetsKm[c] - offsetsKm[pathIdx[i - 1]];
          const dNext = offsetsKm[pathIdx[i + 1]] - offsetsKm[c];
          const v = t1 + t2 + turnPenalty(dPrev, dNext);
          if (v < bestVal - 1e-6) {
            bestVal = v;
            bestC = c;
          }
        }
        if (bestC !== keep) {
          pathIdx[i] = bestC;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  const path: LatLon[] = pathIdx.map((idx, i) => stations[Math.min(i, N)].cand[idx]);

  if (path.length < 2) {
    return planGreatCircle(ctx, from, to);
  }

  // 计算相对大圆的最大横向偏离（公里 → 度）
  let maxDevDeg = 0;
  let maxDevKm = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const gcPoint = fromVec3(slerp(va, vb, t));
    const p = path[i] ?? path[path.length - 1];
    const d = greatCircleDistance(p, gcPoint);
    if (d > maxDevKm) maxDevKm = d;
  }
  maxDevDeg = (maxDevKm / EARTH_R_M) * RAD;

  const points = integrateLegs(ctx, path);
  const gcDist = greatCircleDistance(from, to);
  return summarize('windoptimal', points, gcDist, maxDevDeg);
}

export type Comparison = {
  gc: RouteResult;
  optimal: RouteResult;
  rhumb: RouteResult;
  /** 反向（从 to 到 from）的借风最优 */
  reverse: RouteResult;
  /** 借风相对大圆节省的时间（秒，正为更快） */
  timeSaved: number;
  /** 顺风方向的平均地速 */
  eastboundGs: number;
  westboundGs: number;
  /** 两个方向的时间差（秒） */
  directionDelta: number;
};

export function comparePlans(
  ctx: PlanContext,
  from: LatLon,
  to: LatLon,
  opts?: WindOptimalOptions,
): Comparison {
  const gc = planGreatCircle(ctx, from, to);
  const rhumb = planRhumb(ctx, from, to);

  // DP 在横向走廊上做离散搜索，路径是由 N 个站点连成的折线，
  // 而大圆是 48 段稠密折线——两者对风的采样点不同，DP 可能反而"慢几秒"。
  // 这在物理上没有意义（大圆本身就在 DP 的可行解集合里）。
  //
  // 守卫必须对**两个方向**都生效：早期版本只保护了正向 optimum，
  // 于是 reverse 一旦差于它自己的大圆，界面就会出现
  // 「逆风方向反而更快」这种不可能的结论。
  const guardAgainstCircle = (dp: RouteResult, ref: RouteResult): RouteResult =>
    dp.duration > ref.duration
      ? {
          ...ref,
          kind: 'windoptimal' as const,
          deviationDeg: 0,
          // 回退到大圆时，相对大圆的绕飞量为 0
          extraDistance: 0,
        }
      : dp;

  const optimum = guardAgainstCircle(planWindOptimal(ctx, from, to, opts), gc);
  const revGc = planGreatCircle(ctx, to, from);
  const reverse = guardAgainstCircle(planWindOptimal(ctx, to, from, opts), revGc);

  // 东向 = 经度差为正
  const dLon = normalizeLon(to.lon - from.lon);
  const forward = optimum;
  const backward = reverse;
  const eastboundGs = dLon >= 0 ? forward.avgGroundSpeed : backward.avgGroundSpeed;
  const westboundGs = dLon >= 0 ? backward.avgGroundSpeed : forward.avgGroundSpeed;

  return {
    gc,
    optimal: optimum,
    rhumb,
    reverse,
    timeSaved: gc.duration - optimum.duration,
    eastboundGs,
    westboundGs,
    directionDelta: Math.abs(forward.duration - backward.duration),
  };
}

/** CAT 分段：把航路按湍流等级切成连续的段 */
export type CatSegment = {
  start: number;
  end: number;
  level: 'smooth' | 'light' | 'moderate' | 'severe';
  peak: number;
};

export function catSegments(points: RoutePoint[]): CatSegment[] {
  const segs: CatSegment[] = [];
  let cur: CatSegment | null = null;
  for (const p of points) {
    // 阈值统一引用 CAT_LEVELS，与图例、三维高亮、统计面板共用同一口径
    const level = catLevelOf(p.cat);
    if (!cur || cur.level !== level) {
      if (cur) {
        cur.end = p.distance;
        if (cur.end > cur.start) segs.push(cur);
      }
      cur = { start: p.distance, end: p.distance, level, peak: Number.isFinite(p.cat) ? p.cat : 0 };
    } else {
      cur.end = p.distance;
      if (Number.isFinite(p.cat)) cur.peak = Math.max(cur.peak, p.cat);
    }
  }
  if (cur && cur.end > cur.start) segs.push(cur);
  return segs.filter((s) => s.level !== 'smooth');
}

/** 找出航路上最颠簸的若干点，用于地图标注 */
export function turbulenceHotspots(points: RoutePoint[], limit = 5): RoutePoint[] {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.cat) && p.cat >= CAT_AFFECTED_THRESHOLD)
    .sort((a, b) => b.cat - a.cat);
  const out: RoutePoint[] = [];
  for (const p of sorted) {
    if (out.every((q) => greatCircleDistance(p, q) > 250_000)) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** 给定任意一点，返回该处风场与飞行参数，供 HUD 悬停提示 */
export function probePoint(ctx: PlanContext, lat: number, lon: number) {
  const sampler = makeSampler(ctx);
  const w = sampler.at(lat, lon);
  const tas = machToTas(ctx.mach, w.tempK);
  return {
    ...w,
    tas,
    windKmh: w.speed * 3.6,
    tempC: w.tempK - 273.15,
  };
}

export const _internal = { offsetPoint, integrateLegs, bearingToUV, slerp, toVec3, fromVec3, greatCircleDistance };
