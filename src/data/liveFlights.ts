/**
 * 实时航班匹配
 * ---------------------------------------------------------------------------
 * 设计取舍（重要，写在这里以免后来者重复踩坑）：
 *
 * OpenSky / adsb.lol 这类 ADS-B 源的响应**不带 CORS 头**，
 * 浏览器端无法直接 fetch。因此本模块只做两件事：
 *
 *   1. 如果部署时配置了代理端点（默认 `/api/flights`，由 functions/ 下的
 *      Cloudflare Pages Function 转发），就拉真实航班；
 *   2. 拉不到时，用「当前风场 + 真实机场对」现场合成若干条演示航班，
 *      并在 UI 上明确标注为「模拟」，绝不含糊成「实时」。
 *
 * 这样做的好处是：产品在纯静态托管下依然可用，且永远不会用假数据冒充真数据。
 */

import type { WindField } from '../data/windField';
import { sampleWind, pressureToLevelPos } from '../data/windField';
import { aircraftById, type AircraftProfile, solveWindTriangle, msToKmh } from '../core/atmos';
import {
  initialBearing,
  greatCircleDistance,
  toVec3,
  fromVec3,
  slerp,
  type Vec3,
} from '../core/geo';

export type LiveFlight = {
  callsign: string;
  lat: number;
  lon: number;
  /** 气压高度（米） */
  altitudeM: number;
  /** 地速 m/s */
  groundSpeed: number;
  /** 航迹角 */
  track: number;
  /** 机型代码 */
  type: string;
  origin: string;
  destination: string;
  /** 是否来自真实 ADS-B */
  real: boolean;
  /** 由风场推算的顺风分量（m/s） */
  windAlong: number;
  /** 该点的湍流指数 */
  cat: number;
  /** 真空速估计 */
  tas: number;
};

export type LiveSnapshot = {
  source: 'opensky' | 'adsblol' | 'simulated';
  fetchedAt: number;
  flights: LiveFlight[];
  note?: string;
};

type ProxyResponse = {
  source: string;
  states: Array<{
    callsign: string;
    lat: number;
    lon: number;
    alt: number;
    gs: number;
    track: number;
    type?: string;
  }>;
};

const DEMO_AIRCRAFT: AircraftProfile[] = [
  aircraftById('b77w'),
  aircraftById('a350'),
  aircraftById('b789'),
  aircraftById('a333'),
];

const DEMO_ROUTES: Array<{ from: string; to: string; fromLL: [number, number]; toLL: [number, number] }> = [
  { from: 'JFK', to: 'LHR', fromLL: [40.64, -73.78], toLL: [51.47, -0.46] },
  { from: 'ORD', to: 'FRA', fromLL: [41.98, -87.9], toLL: [50.03, 8.57] },
  { from: 'LAX', to: 'NRT', fromLL: [33.94, -118.41], toLL: [35.77, 140.39] },
  { from: 'SFO', to: 'HND', fromLL: [37.62, -122.38], toLL: [35.55, 139.78] },
  { from: 'CDG', to: 'PEK', fromLL: [49.01, 2.55], toLL: [40.08, 116.58] },
  { from: 'AMS', to: 'JFK', fromLL: [52.31, 4.76], toLL: [40.64, -73.78] },
];

/**
 * 把任意一点的气象条件补进航班对象。
 * 这样列表里每条航班都能显示「它此刻吃到多少顺风、周围颠不颠」。
 */
function enrich(
  field: WindField,
  stepPos: number,
  pressureHpa: number,
  base: Omit<LiveFlight, 'windAlong' | 'cat' | 'tas'>,
): LiveFlight {
  // 必须用调用方当前选择的高度层，否则列表里的顺风分量与地图上的
  // 粒子层不是同一层——「同一份数据可以互相对照」这个前提就破了。
  const levelPos = pressureToLevelPos(field, pressureHpa);
  const w = sampleWind(field, base.lat, base.lon, { levelPos, stepPos });
  const tas = Math.max(base.groundSpeed - w.speed * 0.3, 150);
  const tri = solveWindTriangle(base.track, tas, w);
  return {
    ...base,
    windAlong: -tri.headwindComponent,
    cat: w.cat,
    tas,
  };
}

/** 合成演示航班：沿真实大圆铺开，位置随机但确定（同一时刻结果一致） */
/**
 * 模拟一个符合真实分布的飞行高度（米）。
 *
 * 真实空域里绝大多数飞机在巡航，但总有正在爬升/下降的。
 * 用 70% 巡航、15% 爬升、10% 下降、5% 进近的比例，
 * 让高度带筛选与直方图有真实可看的分布。
 */
function simulateAltitude(
  i: number,
  cruiseAltM: number,
  rnd: (i: number, k: number) => number,
): number {
  const phase = rnd(i, 7);
  if (phase < 0.7) {
    // 巡航：轻微高度层差异
    return cruiseAltM + (rnd(i, 2) - 0.5) * 600;
  }
  if (phase < 0.85) {
    // 爬升：巡航高度的 40%–95%
    return cruiseAltM * (0.4 + rnd(i, 3) * 0.55);
  }
  if (phase < 0.95) {
    // 下降：巡航高度的 35%–85%
    return cruiseAltM * (0.35 + rnd(i, 4) * 0.5);
  }
  // 进近：1500–4500 m
  return 1500 + rnd(i, 5) * 3000;
}

export function simulateFlights(
  field: WindField,
  stepPos: number,
  pressureHpa: number,
  count = 14,
): LiveFlight[] {
  const out: LiveFlight[] = [];
  const seedBase = Math.floor(Date.now() / 120_000);

  const rnd = (i: number, k: number) => {
    const x = Math.sin(seedBase * 12.9898 + i * 78.233 + k * 37.719) * 43758.5453;
    return x - Math.floor(x);
  };

  for (let i = 0; i < count; i++) {
    const route = DEMO_ROUTES[i % DEMO_ROUTES.length];
    const ac = DEMO_AIRCRAFT[i % DEMO_AIRCRAFT.length];
    const t = 0.08 + rnd(i, 1) * 0.84;

    // 大圆插值到当前位置
    const { toVec3, fromVec3, slerp } = sphere;
    const p = fromVec3(
      slerp(
        toVec3(route.fromLL[0], route.fromLL[1]),
        toVec3(route.toLL[0], route.toLL[1]),
        t,
      ),
    );
    const ahead = fromVec3(
      slerp(
        toVec3(route.fromLL[0], route.fromLL[1]),
        toVec3(route.toLL[0], route.toLL[1]),
        Math.min(1, t + 0.01),
      ),
    );

    const track = initialBearing(p, ahead);
    const levelPos = pressureToLevelPos(field, pressureHpa);
    const w = sampleWind(field, p.lat, p.lon, { levelPos, stepPos });
    const tas = ac.cruiseMach * 295;
    const tri = solveWindTriangle(track, tas, w);

    const reverse = i % 3 === 2;
    const from = reverse ? route.to : route.from;
    const to = reverse ? route.from : route.to;
    const finalTrack = reverse ? (track + 180) % 360 : track;
    const tri2 = reverse ? solveWindTriangle(finalTrack, tas, w) : tri;

    out.push({
      callsign: `${['AAL', 'UAL', 'DAL', 'BAW', 'KLH', 'AFR', 'CPA', 'JAL'][i % 8]}${100 + ((i * 137) % 899)}`,
      lat: p.lat,
      lon: p.lon,
      // 模拟航班不能全部钉在巡航高度——那会让高度直方图只有一个柱子，
      // 筛选器也就失去意义。按真实运行剖面分布：
      // 大部分巡航，少数在爬升/下降，极少数在进近。
      altitudeM: simulateAltitude(i, ac.cruiseAltM, rnd),
      groundSpeed: tri2.groundSpeed,
      track: finalTrack,
      type: ac.shortName,
      origin: from,
      destination: to,
      real: false,
      windAlong: -tri2.headwindComponent,
      cat: w.cat,
      tas,
    });
  }
  return out;
}

// 复用 core/geo 的球面实现，避免这里出现第二套（且可能符号不一致的）坐标约定。
const sphere = {
  toVec3: (lat: number, lon: number) => toVec3(lat, lon, 1),
  fromVec3: (v: readonly [number, number, number]) => fromVec3(v),
  slerp: (a: Vec3, b: Vec3, t: number) => slerp(a, b, t),
};

export type FetchOptions = {
  endpoint?: string;
  /** 用于取消过期请求（快速切换航线/连点刷新时避免旧响应覆盖新响应） */
  signal?: AbortSignal;
  /** 只保留巡航高度的航班（米），过滤掉地面与进近 */
  minAltitudeM?: number;
  limit?: number;
};

/**
 * 尝试从代理端点获取真实 ADS-B；失败则退回合成演示。
 * 返回值里的 source 明确告诉 UI 这批数据是什么。
 */
export async function fetchLiveFlights(
  field: WindField,
  stepPos: number,
  pressureHpa: number,
  opts: FetchOptions = {},
): Promise<LiveSnapshot> {
  const endpoint = opts.endpoint ?? '/api/flights';
  const minAlt = opts.minAltitudeM ?? 7600;
  const limit = opts.limit ?? 24;

  try {
    const res = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ProxyResponse;
    if (!Array.isArray(data.states) || data.states.length === 0) {
      throw new Error('代理返回空列表');
    }
    const flights = data.states
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.alt >= minAlt)
      .slice(0, limit)
      .map((s, i) =>
        enrich(field, stepPos, pressureHpa, {
          // 无呼号的航班用坐标派生的唯一标识，不能统一成 '?????'：
          // 那样多条航班共享同一 callsign，选中一艘会同时高亮多行，
          // 详情面板也会显示错误的那一架。
          callsign:
            (s.callsign || '').trim() ||
            `NOID${i}·${s.lat.toFixed(1)}${s.lon.toFixed(1)}`,
          lat: s.lat,
          lon: s.lon,
          altitudeM: s.alt,
          groundSpeed: s.gs,
          track: s.track,
          type: s.type || '—',
          origin: '—',
          destination: '—',
          real: true,
        }),
      );
    if (!flights.length) throw new Error('无巡航高度航班');
    return {
      source: data.source === 'adsblol' ? 'adsblol' : 'opensky',
      fetchedAt: Date.now(),
      flights,
    };
  } catch (e) {
    return {
      source: 'simulated',
      fetchedAt: Date.now(),
      flights: simulateFlights(field, stepPos, pressureHpa, limit),
      note: `未能连接实时 ADS-B 代理（${(e as Error).message}），以下为基于真实风场与真实机场对的模拟航班。`,
    };
  }
}

/** 统计：把航班按顺风/逆风归类，给侧栏做汇总 */
export function summarizeFlights(flights: LiveFlight[]): {
  avgWindAlong: number;
  fastest: LiveFlight | null;
  bumpiest: LiveFlight | null;
  headwindShare: number;
} {
  if (!flights.length) {
    return { avgWindAlong: 0, fastest: null, bumpiest: null, headwindShare: 0 };
  }
  let sum = 0;
  let fast = flights[0];
  let bump = flights[0];
  let head = 0;
  for (const f of flights) {
    sum += f.windAlong;
    if (f.groundSpeed > fast.groundSpeed) fast = f;
    if (f.cat > bump.cat) bump = f;
    if (f.windAlong < 0) head++;
  }
  return {
    avgWindAlong: sum / flights.length,
    fastest: fast,
    bumpiest: bump,
    headwindShare: head / flights.length,
  };
}

/** 机型代码 → 中文类别，供列表展示 */
export function typeLabel(t: string): string {
  if (/^(B77|B78|A35|A33|A34|B74|B76|A38)/.test(t)) return '宽体';
  if (/^(A32|A31|B73|B75|A22)/.test(t)) return '窄体';
  if (/^(E1|CRJ|AT7|DH8)/.test(t)) return '支线';
  return t || '未知';
}

export const _u = { greatCircleDistance, msToKmh };
