/**
 * 航班筛选
 * ---------------------------------------------------------------------------
 * FR24 的筛选器是它的核心生产力：真正用它的人（航司运控、航空爱好者、
 * 记者）都靠"只看某航司 / 只看某高度带 / 只看超速的"来定位目标。
 *
 * 这里的实现刻意是**纯函数 + 声明式条件**：
 *   · 便于单测（不需要 DOM、不需要渲染）
 *   · 筛选条件可以序列化进 URL，分享链接即还原视图
 *   · 统计与列表用同一份逻辑，不会出现"列表 5 条但统计说 8 条"
 */

import type { LiveFlight } from './liveFlights';
import { parseCallsign } from './airlines';
import { CAT_AFFECTED_THRESHOLD } from '../sim/routeEngine';

/** 高度带（米）——与 aircraftLayer 的配色分带保持一致 */
export const ALTITUDE_BANDS_FILTER = [
  { id: 'ground', label: '地面', min: -Infinity, max: 500 },
  { id: 'low', label: '低空', min: 500, max: 3000 },
  { id: 'climb', label: '爬升/下降', min: 3000, max: 7600 },
  { id: 'mid', label: '中高度', min: 7600, max: 10000 },
  { id: 'cruise', label: '巡航', min: 10000, max: Infinity },
] as const;

export type AltitudeBandId = (typeof ALTITUDE_BANDS_FILTER)[number]['id'];

export type FlightFilter = {
  /** 文本查询：呼号 / 航司名 / 机型 / 国家，空格分隔取交集 */
  query: string;
  /** 高度带；空数组 = 不限制 */
  bands: AltitudeBandId[];
  /** ICAO 航司码白名单；空数组 = 不限制 */
  airlines: string[];
  /** 机型代码前缀白名单（如 B77、A35）；空数组 = 不限制 */
  types: string[];
  /** 只看顺风 / 逆风 */
  windMode: 'any' | 'tail' | 'head';
  /** 只看颠簸超过阈值的 */
  turbulenceOnly: boolean;
};

export const EMPTY_FILTER: FlightFilter = {
  query: '',
  bands: [],
  airlines: [],
  types: [],
  windMode: 'any',
  turbulenceOnly: false,
};

export function isFilterActive(f: FlightFilter): boolean {
  return (
    f.query.trim() !== '' ||
    f.bands.length > 0 ||
    f.airlines.length > 0 ||
    f.types.length > 0 ||
    f.windMode !== 'any' ||
    f.turbulenceOnly
  );
}

export function altitudeBandOf(altM: number): AltitudeBandId {
  for (const b of ALTITUDE_BANDS_FILTER) {
    if (altM < b.max) return b.id;
  }
  return 'cruise';
}

/** 单个条件判定。拆出来是为了让测试能逐条覆盖。 */
export function matchesFilter(flight: LiveFlight, f: FlightFilter): boolean {
  // ---- 高度带 ----
  if (f.bands.length > 0 && !f.bands.includes(altitudeBandOf(flight.altitudeM))) {
    return false;
  }

  // ---- 航司 ----
  if (f.airlines.length > 0) {
    const { airline } = parseCallsign(flight.callsign);
    if (!airline || !f.airlines.includes(airline.icao)) return false;
  }

  // ---- 机型（前缀匹配：B77 命中 B77W / B772 / B773）----
  if (f.types.length > 0) {
    const t = (flight.type || '').toUpperCase();
    if (!t) return false;
    if (!f.types.some((p) => t.startsWith(p.toUpperCase()))) return false;
  }

  // ---- 风 ----
  if (f.windMode === 'tail' && flight.windAlong <= 3) return false;
  if (f.windMode === 'head' && flight.windAlong >= -3) return false;

  // ---- 湍流 ----
  if (f.turbulenceOnly && flight.cat < CAT_AFFECTED_THRESHOLD) return false;

  // ---- 文本：空格分隔的每个词都必须命中某个字段 ----
  const q = f.query.trim().toLowerCase();
  if (q) {
    const { airline, flightNo } = parseCallsign(flight.callsign);
    const haystack = [
      flight.callsign,
      flight.type,
      flight.origin,
      flight.destination,
      airline?.name ?? '',
      airline?.nameZh ?? '',
      airline?.country ?? '',
      airline?.iata ?? '',
      flightNo,
    ]
      .join(' ')
      .toLowerCase();

    for (const token of q.split(/\s+/)) {
      if (!haystack.includes(token)) return false;
    }
  }

  return true;
}

export function applyFilter(flights: LiveFlight[], f: FlightFilter): LiveFlight[] {
  if (!isFilterActive(f)) return flights;
  return flights.filter((x) => matchesFilter(x, f));
}

/**
 * 按航司聚合，用于筛选面板展示"当前可见航司 Top N"。
 * 返回按航班数降序的列表。
 */
export function groupByAirline(flights: LiveFlight[]): Array<{
  icao: string;
  nameZh: string;
  name: string;
  country: string;
  cc: string;
  count: number;
}> {
  const m = new Map<string, { nameZh: string; name: string; country: string; cc: string; count: number }>();
  for (const f of flights) {
    const { airline } = parseCallsign(f.callsign);
    if (!airline) continue;
    const cur = m.get(airline.icao);
    if (cur) cur.count += 1;
    else
      m.set(airline.icao, {
        nameZh: airline.nameZh,
        name: airline.name,
        country: airline.country,
        cc: airline.cc,
        count: 1,
      });
  }
  return [...m.entries()]
    .map(([icao, v]) => ({ icao, ...v }))
    .sort((a, b) => b.count - a.count);
}

/** 按机型聚合（前缀归并：B77W/B772 都算 B77） */
export function groupByType(
  flights: LiveFlight[],
): Array<{ type: string; count: number }> {
  const m = new Map<string, number>();
  for (const f of flights) {
    const t = (f.type || '').toUpperCase();
    if (!t) continue;
    // 取前三位作为系列（B77W → B77，A359 → A35）
    const series = t.slice(0, 3);
    m.set(series, (m.get(series) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

/** 高度带分布，用于统计条 */
export function altitudeHistogram(
  flights: LiveFlight[],
): Array<{ id: AltitudeBandId; label: string; count: number }> {
  const counts = new Map<AltitudeBandId, number>();
  for (const f of flights) {
    const b = altitudeBandOf(f.altitudeM);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return ALTITUDE_BANDS_FILTER.map((b) => ({
    id: b.id,
    label: b.label,
    count: counts.get(b.id) ?? 0,
  }));
}
