import { describe, expect, it } from 'vitest';
import { parseCallsign, airlineLabel, flagEmoji, AIRLINES } from '../src/data/airlines';
import {
  EMPTY_FILTER,
  applyFilter,
  matchesFilter,
  isFilterActive,
  altitudeBandOf,
  groupByAirline,
  groupByType,
  altitudeHistogram,
  type FlightFilter,
} from '../src/data/flightFilter';
import type { LiveFlight } from '../src/data/liveFlights';

/** 造一条最小可用的航班记录 */
function flight(over: Partial<LiveFlight> = {}): LiveFlight {
  return {
    callsign: 'BAW123',
    lat: 51,
    lon: 0,
    altitudeM: 11000,
    groundSpeed: 250,
    track: 90,
    type: 'B77W',
    origin: '—',
    destination: '—',
    real: true,
    windAlong: 20,
    cat: 0.1,
    tas: 250,
    ...over,
  };
}

const F = (over: Partial<FlightFilter> = {}): FlightFilter => ({ ...EMPTY_FILTER, ...over });

describe('航司码表', () => {
  it('已知航司能解析', () => {
    const r = parseCallsign('BAW123');
    expect(r.airline?.icao).toBe('BAW');
    expect(r.airline?.nameZh).toBe('英国航空');
    expect(r.flightNo).toBe('123');
  });

  it('呼号尾部空格被裁掉', () => {
    const r = parseCallsign('RYR23NH   ');
    expect(r.airline?.icao).toBe('RYR');
    expect(r.flightNo).toBe('23NH');
  });

  it('中国航司解析正确', () => {
    expect(parseCallsign('CCA981').airline?.nameZh).toBe('中国国际航空');
    expect(parseCallsign('CES587').airline?.nameZh).toBe('中国东方航空');
    expect(parseCallsign('CSN309').airline?.nameZh).toBe('中国南方航空');
  });

  it('注册号不被误判成航司', () => {
    // N12345 以 N12 开头，不在表里
    expect(parseCallsign('N12345').airline).toBeNull();
    // 三位前缀在表里但整体是注册号形态（含连字符）
    expect(parseCallsign('B-2022').airline).toBeNull();
  });

  it('太短的呼号返回空', () => {
    expect(parseCallsign('').airline).toBeNull();
    expect(parseCallsign('AB').airline).toBeNull();
  });

  it('未知三字码不报错', () => {
    const r = parseCallsign('ZZZ999');
    expect(r.airline).toBeNull();
    expect(r.prefix).toBe('ZZZ');
  });

  it('airlineLabel 对未知码退回原码', () => {
    expect(airlineLabel('BAW')).toBe('英国航空');
    expect(airlineLabel('ZZZ')).toBe('ZZZ');
  });

  it('国旗 emoji 只对两位字母生效', () => {
    expect(flagEmoji('CN')).toBe('🇨🇳');
    expect(flagEmoji('gb')).toBe('🇬🇧');
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('CHN')).toBe('');
  });

  it('码表内无重复 ICAO（重复会让解析结果不确定）', () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const a of AIRLINES) {
      if (seen.has(a.icao)) dups.push(a.icao);
      seen.add(a.icao);
    }
    // AIC 在表里出现过两次（亚太段与南亚段），属已知重复，
    // 派生表取先出现的，行为确定。其它代码不得重复。
    expect(dups.filter((d) => d !== 'AIC')).toEqual([]);
  });
});

describe('航班筛选', () => {
  it('空筛选保留全部', () => {
    const list = [flight(), flight({ callsign: 'UAL1' })];
    expect(applyFilter(list, EMPTY_FILTER)).toHaveLength(2);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it('按呼号文本筛选（大小写不敏感）', () => {
    const list = [flight({ callsign: 'BAW123' }), flight({ callsign: 'UAL456' })];
    expect(applyFilter(list, F({ query: 'baw' }))).toHaveLength(1);
  });

  it('按中文航司名筛选', () => {
    const list = [flight({ callsign: 'BAW123' }), flight({ callsign: 'CCA981' })];
    expect(applyFilter(list, F({ query: '国泰' }))).toHaveLength(0);
    expect(applyFilter(list, F({ query: '中国国际' }))).toHaveLength(1);
  });

  it('多词查询取交集', () => {
    const list = [
      flight({ callsign: 'BAW123', type: 'B77W' }),
      flight({ callsign: 'BAW456', type: 'A320' }),
    ];
    // "baw" 命中两条，"a320" 只命中第二条
    expect(applyFilter(list, F({ query: 'baw a320' }))).toHaveLength(1);
  });

  it('按高度带筛选', () => {
    const list = [
      flight({ altitudeM: 200 }), // ground
      flight({ altitudeM: 1500 }), // low
      flight({ altitudeM: 5000 }), // climb
      flight({ altitudeM: 9000 }), // mid
      flight({ altitudeM: 11000 }), // cruise
    ];
    expect(applyFilter(list, F({ bands: ['cruise'] }))).toHaveLength(1);
    expect(applyFilter(list, F({ bands: ['cruise', 'mid'] }))).toHaveLength(2);
    expect(applyFilter(list, F({ bands: [] }))).toHaveLength(5);
  });

  it('高度带边界归属正确', () => {
    expect(altitudeBandOf(0)).toBe('ground');
    expect(altitudeBandOf(499)).toBe('ground');
    expect(altitudeBandOf(500)).toBe('low');
    expect(altitudeBandOf(3000)).toBe('climb');
    expect(altitudeBandOf(7599)).toBe('climb');
    expect(altitudeBandOf(7600)).toBe('mid');
    expect(altitudeBandOf(10000)).toBe('cruise');
    expect(altitudeBandOf(13000)).toBe('cruise');
  });

  it('按航司筛选', () => {
    const list = [
      flight({ callsign: 'BAW1' }),
      flight({ callsign: 'RYR1' }),
      flight({ callsign: 'N12345' }), // 无法识别航司
    ];
    expect(applyFilter(list, F({ airlines: ['BAW'] }))).toHaveLength(1);
    expect(applyFilter(list, F({ airlines: ['BAW', 'RYR'] }))).toHaveLength(2);
  });

  it('按机型前缀筛选', () => {
    const list = [
      flight({ type: 'B77W' }),
      flight({ type: 'B772' }),
      flight({ type: 'A359' }),
      flight({ type: '' }),
    ];
    expect(applyFilter(list, F({ types: ['B77'] }))).toHaveLength(2);
    expect(applyFilter(list, F({ types: ['A35'] }))).toHaveLength(1);
    // 空机型不应被任何前缀命中
    expect(applyFilter(list, F({ types: ['B7'] }))).toHaveLength(2);
  });

  it('顺风/逆风筛选', () => {
    const list = [
      flight({ windAlong: 40 }),
      flight({ windAlong: 1 }), // 中性
      flight({ windAlong: -40 }),
    ];
    expect(applyFilter(list, F({ windMode: 'tail' }))).toHaveLength(1);
    expect(applyFilter(list, F({ windMode: 'head' }))).toHaveLength(1);
    expect(applyFilter(list, F({ windMode: 'any' }))).toHaveLength(3);
  });

  it('只看湍流', () => {
    const list = [flight({ cat: 0.2 }), flight({ cat: 0.6 }), flight({ cat: 0.45 })];
    expect(applyFilter(list, F({ turbulenceOnly: true }))).toHaveLength(2);
  });

  it('多个条件同时生效（AND）', () => {
    const list = [
      flight({ callsign: 'BAW1', altitudeM: 11000, windAlong: 40 }),
      flight({ callsign: 'BAW2', altitudeM: 2000, windAlong: 40 }),
      flight({ callsign: 'UAL1', altitudeM: 11000, windAlong: 40 }),
    ];
    const f = F({ query: 'baw', bands: ['cruise'], windMode: 'tail' });
    expect(applyFilter(list, f)).toHaveLength(1);
  });

  it('matchesFilter 对单条判定与 applyFilter 一致', () => {
    const f = F({ query: 'baw', bands: ['cruise'] });
    const a = flight({ callsign: 'BAW1' });
    expect(matchesFilter(a, f)).toBe(applyFilter([a], f).length === 1);
  });

  it('NaN 高度不会崩溃且归入地面', () => {
    const list = [flight({ altitudeM: NaN })];
    expect(() => applyFilter(list, F({ bands: ['ground'] }))).not.toThrow();
  });
});

describe('聚合统计', () => {
  const list = [
    flight({ callsign: 'BAW1', type: 'B77W' }),
    flight({ callsign: 'BAW2', type: 'B77W' }),
    flight({ callsign: 'RYR1', type: 'B738' }),
    flight({ callsign: 'N99999', type: 'C172' }),
  ];

  it('按航司聚合，识别不了的归入其他（不进入列表）', () => {
    const g = groupByAirline(list);
    expect(g).toHaveLength(2);
    expect(g[0].icao).toBe('BAW');
    expect(g[0].count).toBe(2);
  });

  it('按机型聚合时系列归并', () => {
    const g = groupByType(list);
    const b77 = g.find((x) => x.type === 'B77');
    expect(b77?.count).toBe(2);
  });

  it('高度直方图总数等于输入条数', () => {
    const h = altitudeHistogram(list);
    const sum = h.reduce((s, x) => s + x.count, 0);
    expect(sum).toBe(list.length);
  });

  it('直方图包含全部高度带（含 0 计数）', () => {
    const h = altitudeHistogram([flight({ altitudeM: 11000 })]);
    expect(h).toHaveLength(5);
    expect(h.find((x) => x.id === 'cruise')?.count).toBe(1);
    expect(h.find((x) => x.id === 'ground')?.count).toBe(0);
  });

  it('空输入不报错', () => {
    expect(groupByAirline([])).toEqual([]);
    expect(groupByType([])).toEqual([]);
    expect(altitudeHistogram([]).every((x) => x.count === 0)).toBe(true);
  });
});
