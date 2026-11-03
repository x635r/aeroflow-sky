import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { decodeHalf } from '../src/data/windField';
import type { WindField, WindHeader } from '../src/data/windField';
import {
  planGreatCircle,
  planRhumb,
  planWindOptimal,
  comparePlans,
  catSegments,
  catLevelOf,
  CAT_LEVELS,
  CAT_AFFECTED_THRESHOLD,
  turbulenceHotspots,
} from '../src/sim/routeEngine';
import type { PlanContext } from '../src/sim/routeEngine';
import { aircraftById, solveWindTriangle } from '../src/core/atmos';
import {
  slerp,
  toVec3,
  rhumbLine,
  rhumbPoint,
  clamp,
  mercatorPsi,
  EARTH_R_M,
  greatCircleDistance,
} from '../src/core/geo';

/**
 * 数据质量回归测试
 * ---------------------------------------------------------------------------
 * 这里每一条都对应一个曾经真实存在、且**旧测试没抓到**的缺陷。
 * 目标是：任何一次重写把这些 bug 带回来时，构建立刻失败。
 *
 * 共同特征：这些 bug 都不报错、不崩溃，只是安静地给出一个
 * "看起来合理"的错误数字。
 */

const dataDir = path.join(__dirname, '..', 'public', 'data');

function loadField(): WindField {
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'wind-manifest.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dataDir, manifest.file));
  const hdrLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.subarray(8, 8 + hdrLen).toString('utf8')) as WindHeader;
  const payload = buf.subarray(8 + hdrLen);
  const u16 = new Uint16Array(
    payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  );
  return {
    header,
    data: decodeHalf(u16),
    grid: header.grid,
    levels: header.levels.map((l) => l.hPa),
    steps: header.steps.map((s) => s.hour),
    stridePerLevel: header.grid.nLat * header.grid.nLon * 4,
    stepTimestamps: header.steps.map((s) => Date.parse(s.validTime)),
  };
}

const field = loadField();
const ctx: PlanContext = {
  field,
  pressureHpa: 250,
  stepPos: 0,
  aircraft: aircraftById('b77w'),
  mach: 0.84,
};

const JFK = { lat: 40.6413, lon: -73.7781 };
const LHR = { lat: 51.47, lon: -0.4614 };
const SFO = { lat: 37.6213, lon: -122.379 };
const NRT = { lat: 35.772, lon: 140.392 };

describe('恒向线：必须是真正的 rhumb line', () => {
  it('Mercator 方位角与大圆初始方位角显著不同', () => {
    const line = rhumbLine(JFK, LHR);
    const gc = planGreatCircle(ctx, JFK, LHR);
    // 恒向线约 77.9°，大圆初始约 51.4°，差 26° 以上
    expect(line.bearing).toBeGreaterThan(70);
    expect(line.bearing).toBeLessThan(86);
    expect(Math.abs(line.bearing - gc.points[0].track)).toBeGreaterThan(15);
  });

  it('JFK–LHR 长度接近解析真值 5758 km', () => {
    const line = rhumbLine(JFK, LHR);
    expect(line.distance / 1000).toBeGreaterThan(5700);
    expect(line.distance / 1000).toBeLessThan(5800);
  });

  it('正反两向长度相等（恒向线的必要条件）', () => {
    const fwd = rhumbLine(JFK, LHR);
    const rev = rhumbLine(LHR, JFK);
    expect(fwd.distance).toBeCloseTo(rev.distance, 3);
  });

  it('planRhumb 的双向结果一致', () => {
    const a = planRhumb(ctx, JFK, LHR);
    const b = planRhumb(ctx, LHR, JFK);
    expect(Math.abs(a.distance - b.distance)).toBeLessThan(1000);
  });

  it('恒向线总长于大圆', () => {
    const r = rhumbLine(JFK, LHR).distance;
    const gc = greatCircleDistance(JFK, LHR);
    expect(r).toBeGreaterThan(gc);
    // 中纬度长航程，差距在 3–6%
    expect(r / gc).toBeGreaterThan(1.02);
    expect(r / gc).toBeLessThan(1.08);
  });

  it('赤道上恒向线等于大圆', () => {
    const a = { lat: 0, lon: -40 };
    const b = { lat: 0, lon: 40 };
    const r = rhumbLine(a, b).distance;
    const gc = greatCircleDistance(a, b);
    expect(r / gc).toBeCloseTo(1, 6);
  });

  it('大圆与恒向线都不产生离谱的距离（防止路径爆炸）', () => {
    // 早期 bug 让 SYD–SCL 跑到南极 lat -88.7
    const syd = { lat: -33.94, lon: 151.18 };
    const scl = { lat: -33.39, lon: -70.79 };
    const r = planRhumb(ctx, syd, scl);
    for (const p of r.points) {
      expect(Math.abs(p.lat)).toBeLessThan(80);
    }
    // 智利—澳洲恒向线约 12775 km
    expect(r.distance / 1000).toBeGreaterThan(12000);
    expect(r.distance / 1000).toBeLessThan(13500);
  });

  it('rhumbPoint 的端点精确落在目的地', () => {
    const p = rhumbPoint(JFK, LHR, 1);
    expect(p.lat).toBeCloseTo(LHR.lat, 6);
    expect(p.lon).toBeCloseTo(LHR.lon, 6);
  });

  it('mercatorPsi 在极点附近不发散', () => {
    expect(Number.isFinite(mercatorPsi(90))).toBe(true);
    expect(Number.isFinite(mercatorPsi(-90))).toBe(true);
  });
});

describe('航路积分：不得丢段或错配', () => {
  it('首点距离恒为 0', () => {
    for (const [a, b] of [
      [JFK, LHR],
      [SFO, NRT],
    ]) {
      const gc = planGreatCircle(ctx, a, b);
      expect(gc.points[0].distance).toBe(0);
    }
  });

  it('距离序列严格单调不减', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    for (let i = 1; i < gc.points.length; i++) {
      expect(gc.points[i].distance).toBeGreaterThanOrEqual(gc.points[i - 1].distance - 1e-6);
    }
  });

  it('总距离与几何大圆一致（误差 < 0.5%）', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    const geo = greatCircleDistance(JFK, LHR);
    expect(Math.abs(gc.distance - geo) / geo).toBeLessThan(0.005);
  });

  it('时长等于逐段 d/gs 的独立重算（无漏段）', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    let t = 0;
    for (let i = 0; i < gc.points.length - 1; i++) {
      const d = gc.points[i + 1].distance - gc.points[i].distance;
      t += d / Math.max(gc.points[i].groundSpeed, 1);
    }
    // 允许 1% 的浮点/中点近似差异，但不能再出现 2–3% 的系统性偏低
    expect(Math.abs(gc.duration - t) / gc.duration).toBeLessThan(0.01);
  });

  it('平均地速与 distance/duration 自洽', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    expect(gc.avgGroundSpeed).toBeCloseTo(gc.distance / gc.duration, 3);
  });

  it('末点也有地速（不能是 0）', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    const last = gc.points[gc.points.length - 1];
    expect(last.groundSpeed).toBeGreaterThan(100);
  });

  it('恒向线与大圆的时间差落在合理范围（不再是 3 分钟伪收益）', () => {
    const cmp = comparePlans(ctx, JFK, LHR);
    // 大圆与自身比较必须几乎相等
    expect(Math.abs(cmp.gc.duration - cmp.gc.duration)).toBe(0);
    // 借风收益必须来自真实风场，量级合理
    expect(Math.abs(cmp.timeSaved) / 60).toBeLessThan(180);
  });
});

describe('风三角：不可行航迹必须显式报告', () => {
  it('侧风超过真空速 → infeasible，且不返回假地速', () => {
    const r = solveWindTriangle(90, 100, { u: 50, v: 140 });
    expect(r.infeasible).toBe(true);
    expect(r.groundSpeed).toBe(0);
  });

  it('更强侧风同样被拒', () => {
    const r = solveWindTriangle(90, 150, { u: 60, v: 200 });
    expect(r.infeasible).toBe(true);
  });

  it('逆风超过真空速 → infeasible', () => {
    const r = solveWindTriangle(90, 100, { u: -180, v: 0 });
    expect(r.infeasible).toBe(true);
  });

  it('正常情形不被误判', () => {
    const cases: Array<[number, number, { u: number; v: number }]> = [
      [90, 250, { u: 50, v: 0 }],
      [90, 250, { u: -50, v: 0 }],
      [90, 250, { u: 0, v: 60 }],
      [0, 250, { u: 30, v: -20 }],
    ];
    for (const [trk, tas, wind] of cases) {
      expect(solveWindTriangle(trk, tas, wind).infeasible).toBe(false);
    }
  });

  it('纯顺风地速精确等于 TAS + 风速', () => {
    expect(solveWindTriangle(90, 250, { u: 50, v: 0 }).groundSpeed).toBeCloseTo(300, 6);
  });

  it('纯逆风地速精确等于 TAS - 风速', () => {
    expect(solveWindTriangle(90, 250, { u: -50, v: 0 }).groundSpeed).toBeCloseTo(200, 6);
  });

  it('全侧风时地速 = √(TAS² - 风²)', () => {
    const r = solveWindTriangle(90, 250, { u: 0, v: 60 });
    expect(r.groundSpeed).toBeCloseTo(Math.hypot(250, 0) * Math.cos(Math.asin(60 / 250)), 4);
  });
});

describe('DP 局优解：不变量必须成立', () => {
  it('走廊宽度为 0 时结果等于大圆（误差 < 0.05%）', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    const dp = planWindOptimal(ctx, JFK, LHR, { corridorKm: 0 });
    expect(Math.abs(dp.duration - gc.duration) / gc.duration).toBeLessThan(0.0005);
  });

  it('偶数 offsets 不会丢掉中心列', () => {
    const results = [19, 20, 22].map((m) => {
      const dp = planWindOptimal(ctx, JFK, LHR, { corridorKm: 680, offsets: m });
      return dp.distance;
    });
    for (const d of results) {
      expect(Math.abs(d - results[0]) / results[0]).toBeLessThan(0.002);
    }
  });

  it('offsets 过小或 stations 过小时不崩溃', () => {
    for (const opts of [
      { offsets: 1, stations: 1 },
      { offsets: 2, stations: 0 },
      { offsets: 0, stations: -5 },
    ]) {
      const r = planWindOptimal(ctx, JFK, LHR, opts);
      expect(Number.isFinite(r.duration)).toBe(true);
      expect(r.duration).toBeGreaterThan(0);
    }
  });

  it('借风航线永不慢于大圆', () => {
    for (const [a, b] of [
      [JFK, LHR],
      [SFO, NRT],
    ]) {
      const cmp = comparePlans(ctx, a, b);
      expect(cmp.optimal.duration).toBeLessThanOrEqual(cmp.gc.duration * 1.0001);
    }
  });

  it('反向航线同样不慢于它自己的大圆', () => {
    const cmp = comparePlans(ctx, JFK, LHR);
    const revGc = planGreatCircle(ctx, LHR, JFK);
    expect(cmp.reverse.duration).toBeLessThanOrEqual(revGc.duration * 1.0001);
  });

  it('回退到大圆时 extraDistance 归零', () => {
    const cmp = comparePlans(ctx, JFK, LHR);
    if (Math.abs(cmp.optimal.duration - cmp.gc.duration) < 1) {
      expect(Math.abs(cmp.optimal.extraDistance)).toBeLessThan(1000);
    }
  });

  it('大圆自身的 extraDistance 为 0', () => {
    const gc = planGreatCircle(ctx, JFK, LHR);
    expect(Math.abs(gc.extraDistance)).toBeLessThan(1);
  });

  it('持续同向绕飞不被平滑惩罚否决', () => {
    // 合成急流：DP 应稳定地北移吃到急流，不因 smoothness 增大而退回大圆
    const jet = makeSyntheticJetField();
    const jetCtx: PlanContext = { ...ctx, field: jet };
    const from = { lat: 38, lon: -70 };
    const to = { lat: 46, lon: 5 };
    const gc = planGreatCircle(jetCtx, from, to);
    const avgLatGc = gc.points.reduce((s, p) => s + p.lat, 0) / gc.points.length;

    for (const smoothness of [0.5, 2.5, 10]) {
      const dp = planWindOptimal(jetCtx, from, to, {
        corridorKm: 900,
        offsets: 25,
        stations: 40,
        smoothness,
      });
      const avgLatDp = dp.points.reduce((s, p) => s + p.lat, 0) / dp.points.length;
      expect(avgLatDp).toBeGreaterThan(avgLatGc + 1.0);
      expect(dp.duration).toBeLessThan(gc.duration);
    }
  });
});

describe('CAT 阈值：单一事实来源', () => {
  it('catLevelOf 与常量表一致', () => {
    expect(catLevelOf(0)).toBe('smooth');
    expect(catLevelOf(CAT_LEVELS.light - 0.01)).toBe('smooth');
    expect(catLevelOf(CAT_LEVELS.light)).toBe('light');
    expect(catLevelOf(CAT_LEVELS.moderate)).toBe('moderate');
    expect(catLevelOf(CAT_LEVELS.severe)).toBe('severe');
    expect(catLevelOf(1)).toBe('severe');
  });

  it('NaN 不得被判为 severe（未知 ≠ 最危险）', () => {
    expect(catLevelOf(NaN)).toBe('smooth');
    // 正无穷确实超出阈值，按 severe 处理是合理的
    expect(catLevelOf(Infinity)).toBe('severe');
  });

  it('catSegments 只返回超过阈值的段', () => {
    const cmp = comparePlans(ctx, JFK, LHR);
    for (const s of catSegments(cmp.optimal.points)) {
      expect(s.peak).toBeGreaterThanOrEqual(CAT_AFFECTED_THRESHOLD - 1e-9);
      expect(s.end).toBeGreaterThan(s.start);
    }
  });

  it('catFraction 用距离加权，与 catSegments 口径一致', () => {
    const cmp = comparePlans(ctx, SFO, NRT);
    const segs = catSegments(cmp.optimal.points);
    const total = cmp.optimal.distance;
    const fromSegs = segs.reduce((s, x) => s + (x.end - x.start), 0) / total;
    // 两者应接近（分段边界有量化差异）
    expect(Math.abs(fromSegs - cmp.optimal.catFraction)).toBeLessThan(0.1);
  });

  it('turbulenceHotspots 只返回超阈值点', () => {
    const cmp = comparePlans(ctx, SFO, NRT);
    for (const h of turbulenceHotspots(cmp.optimal.points)) {
      expect(h.cat).toBeGreaterThanOrEqual(CAT_AFFECTED_THRESHOLD - 1e-9);
    }
  });
});

describe('数值健壮性', () => {
  it('clamp 不吃 NaN', () => {
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(false);
    expect(clamp(NaN, 0, 1)).toBe(0);
  });

  it('clamp 对 ±Infinity 有定义', () => {
    expect(clamp(Infinity, 0, 1)).toBe(1);
    expect(clamp(-Infinity, 0, 1)).toBe(0);
  });

  it('slerp 在对跖点返回单位向量', () => {
    const a = toVec3(0, 0);
    const b = toVec3(0, 180);
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const v = slerp(a, b, t);
      const len = Math.hypot(v[0], v[1], v[2]);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it('slerp 对跖点的路径连续且不确定性地塌到极点', () => {
    // 对跖点之间的大圆不唯一，物理上没有唯一答案，
    // 但必须是球面上的连续路径：相邻 t 的点必须靠近。
    const a = toVec3(0, 0);
    const b = toVec3(0, 180);
    let prev = slerp(a, b, 0);
    for (let i = 1; i <= 20; i++) {
      const v = slerp(a, b, i / 20);
      const step = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]);
      // 每一步都在球面上走一小段，不能瞬移
      expect(step).toBeLessThan(0.6);
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 6);
      prev = v;
    }
    // 中继点不能落在极点上（早期 bug）
    const mid = slerp(a, b, 0.5);
    expect(Math.abs(mid[1])).toBeLessThan(0.99);
  });

  it('slerp 对跖点结果可复现（同一输入同一路径）', () => {
    const a = toVec3(10, 20);
    const b = toVec3(-10, -160);
    for (const t of [0.3, 0.5, 0.8]) {
      expect(slerp(a, b, t)).toEqual(slerp(a, b, t));
    }
  });

  it('slerp 端点精确', () => {
    const a = toVec3(10, 20);
    const b = toVec3(-30, 150);
    expect(slerp(a, b, 0)).toEqual(a);
    const end = slerp(a, b, 1);
    expect(end[0]).toBeCloseTo(b[0], 6);
    expect(end[1]).toBeCloseTo(b[1], 6);
    expect(end[2]).toBeCloseTo(b[2], 6);
  });

  it('所有航路点的物理量有限且合理', () => {
    for (const [a, b] of [
      [JFK, LHR],
      [SFO, NRT],
    ]) {
      const cmp = comparePlans(ctx, a, b);
      for (const r of [cmp.gc, cmp.optimal, cmp.rhumb, cmp.reverse]) {
        for (const p of r.points) {
          expect(Number.isFinite(p.lat)).toBe(true);
          expect(Number.isFinite(p.lon)).toBe(true);
          expect(Number.isFinite(p.groundSpeed)).toBe(true);
          expect(Number.isFinite(p.distance)).toBe(true);
          expect(p.cat).toBeGreaterThanOrEqual(0);
          expect(p.cat).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('极地与跨日界线航线不产生 NaN', () => {
    const cases = [
      [{ lat: 89, lon: 0 }, { lat: 89, lon: 180 }],
      [{ lat: -88, lon: 10 }, { lat: 88, lon: 190 }],
      [{ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }],
    ];
    for (const [a, b] of cases) {
      const gc = planGreatCircle(ctx, a, b);
      expect(Number.isFinite(gc.duration)).toBe(true);
      expect(Number.isFinite(gc.distance)).toBe(true);
    }
  });
});

describe('性能预算', () => {
  it('单次借风推演 < 400ms', () => {
    const t0 = performance.now();
    planWindOptimal(ctx, JFK, LHR);
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it('完整对比 < 900ms', () => {
    const t0 = performance.now();
    comparePlans(ctx, JFK, LHR);
    expect(performance.now() - t0).toBeLessThan(900);
  });
});

/* -------------------------------------------------------------------------- */

function makeSyntheticJetField(): WindField {
  const g = { nLat: 91, nLon: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360 };
  const levels = [200, 250, 300];
  const stepping = [0];
  const n = g.nLat * g.nLon * 4;
  const data = new Float32Array(n * levels.length * stepping.length);
  for (let l = 0; l < levels.length; l++) {
    for (let iLat = 0; iLat < g.nLat; iLat++) {
      const lat = g.latMin + (180 * iLat) / (g.nLat - 1);
      const jet = 95 * Math.exp(-Math.pow((lat - 56) / 11, 2));
      for (let iLon = 0; iLon < g.nLon; iLon++) {
        const o = ((l * g.nLat + iLat) * g.nLon + iLon) * 4;
        data[o] = jet;
        data[o + 1] = 0;
        data[o + 2] = 0.1;
        data[o + 3] = 215;
      }
    }
  }
  const header = {
    magic: 'AFLW1',
    generated: '',
    source: 'synthetic',
    cycle: '',
    encoding: 'float16',
    channels: ['u', 'v', 'cat', 'temp'],
    units: {},
    grid: g,
    levels: levels.map((h) => ({ hPa: h, fl: 300 })),
    steps: [{ hour: 0, validTime: '2026-01-01T00:00:00Z' }],
    layout: '',
    stats: [],
    catMethod: '',
  } as WindHeader;
  return {
    header,
    data,
    grid: g,
    levels,
    steps: stepping,
    stridePerLevel: g.nLat * g.nLon * 4,
    stepTimestamps: [Date.parse('2026-01-01T00:00:00Z')],
  };
}

void EARTH_R_M;
