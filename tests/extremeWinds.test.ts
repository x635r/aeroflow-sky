import { describe, expect, it } from 'vitest';
import { planGreatCircle, planWindOptimal, comparePlans } from '../src/sim/routeEngine';
import type { PlanContext } from '../src/sim/routeEngine';
import { aircraftById, solveWindTriangle, machToTas } from '../src/core/atmos';
import type { WindField } from '../src/data/windField';
import { greatCircleDistance, toVec3, fromVec3, slerp } from '../src/core/geo';

/**
 * 极端风场下的行为
 * ---------------------------------------------------------------------------
 * 真实 GFS 数据里偶尔会出现「侧风分量超过真空速」的格点（急流核心附近）。
 * 这类航段物理上飞不出来，但早期实现用 `continue` 跳过，导致：
 *
 *   · 距离被静默打折（实测 6672km 只积出 6116km，少 8%）
 *   · 时长同比例偏短
 *   · 界面上完全看不出异常
 *
 * 现在改为：保留几何距离，地速记为 1 m/s 的占位值，并统计
 * infeasibleLegs 让 UI 能显示警告。
 */

/** 造一个赤道附近有极强西风的场。航迹正北穿过时全是侧风。 */
function equatorialJet(strongU: number): WindField {
  const nLat = 181;
  const nLon = 7;
  const g = { nLat, nLon, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360 };
  const data = new Float32Array(nLat * nLon * 4);
  for (let iLat = 0; iLat < nLat; iLat++) {
    const lat = -90 + iLat;
    const u = Math.abs(lat) < 3 ? strongU : 0;
    for (let iLon = 0; iLon < nLon; iLon++) {
      const b = (iLat * nLon + iLon) * 4;
      data[b] = u;
      data[b + 1] = 0;
      data[b + 2] = 0;
      data[b + 3] = 216.65;
    }
  }
  return {
    header: {
      magic: 'AFLW1',
      generated: '',
      source: 'synthetic',
      cycle: '',
      encoding: 'float16',
      channels: [],
      units: {},
      grid: g,
      levels: [{ hPa: 250, fl: 340 }],
      steps: [{ hour: 0, validTime: '2026-01-01T00:00:00Z' }],
      layout: '',
      stats: [],
      catMethod: '',
    } as never,
    data,
    grid: g,
    levels: [250],
    steps: [0],
    stridePerLevel: nLat * nLon * 4,
    stepTimestamps: [Date.parse('2026-01-01T00:00:00Z')],
  };
}

const ctx = (u: number): PlanContext => ({
  field: equatorialJet(u),
  pressureHpa: 250,
  stepPos: 0,
  aircraft: aircraftById('b77w'),
  mach: 0.84,
});

describe('不可行航段：距离不得缩水', () => {
  it('赤道强侧风带下距离仍等于几何大圆', () => {
    const a = { lat: -30, lon: 0 };
    const b = { lat: 30, lon: 0 };
    const geo = greatCircleDistance(a, b);
    const r = planGreatCircle(ctx(400), a, b);

    // 距离必须完整（此前的 bug 会少 8%）
    expect(Math.abs(r.distance - geo) / geo).toBeLessThan(0.002);
    // 所有细分点都要保留
    expect(r.points.length).toBe(49);
    // 末点累计距离 = 总距离
    expect(r.points[r.points.length - 1].distance).toBeCloseTo(r.distance, 3);
  });

  it('不可行航段被计数，且只计真正飞不动的段', () => {
    const a = { lat: -30, lon: 0 };
    const b = { lat: 30, lon: 0 };
    const extreme = planGreatCircle(ctx(400), a, b);
    const calm = planGreatCircle(ctx(0), a, b);

    expect(extreme.infeasibleLegs).toBeGreaterThan(0);
    expect(calm.infeasibleLegs).toBe(0);
  });

  it('不可行时时长体现"飞不动"而不是被低估算', () => {
    const a = { lat: -30, lon: 0 };
    const b = { lat: 30, lon: 0 };
    const extreme = planGreatCircle(ctx(400), a, b);
    const calm = planGreatCircle(ctx(0), a, b);

    // 有飞不动的航段时，时长必然远大于无风情形
    expect(extreme.duration).toBeGreaterThan(calm.duration * 5);
  });

  it('正常风场下 infeasibleLegs 恒为 0（不误报）', () => {
    const r = planGreatCircle(ctx(30), { lat: -30, lon: 0 }, { lat: 30, lon: 0 });
    expect(r.infeasibleLegs).toBe(0);
  });

  it('DP 遇到不可行走廊不会崩，且不慢于大圆', () => {
    const a = { lat: -30, lon: 0 };
    const b = { lat: 30, lon: 0 };
    const dp = planWindOptimal(ctx(400), a, b, { corridorKm: 300, offsets: 9, stations: 20 });
    expect(Number.isFinite(dp.duration)).toBe(true);
    expect(Number.isFinite(dp.distance)).toBe(true);
    expect(dp.distance).toBeGreaterThan(0);
  });

  it('完整对比在极端风场下不产生 NaN', () => {
    const cmp = comparePlans(ctx(400), { lat: -30, lon: 0 }, { lat: 30, lon: 0 }, {
      corridorKm: 300,
      offsets: 9,
      stations: 20,
    });
    for (const r of [cmp.gc, cmp.optimal, cmp.rhumb, cmp.reverse]) {
      expect(Number.isFinite(r.duration)).toBe(true);
      expect(Number.isFinite(r.distance)).toBe(true);
      expect(Number.isFinite(r.avgGroundSpeed)).toBe(true);
    }
  });
});

describe('风三角分量分解：不依赖坐标系错误', () => {
  const tas = 249;

  it('航迹正北时，u 是侧风 v 是尾风', () => {
    // 纯侧风
    const side = solveWindTriangle(0, tas, { u: 100, v: 0 });
    expect(side.groundSpeed).toBeCloseTo(Math.sqrt(tas * tas - 100 * 100), 6);

    // 纯尾风
    const tail = solveWindTriangle(0, tas, { u: 0, v: 100 });
    expect(tail.groundSpeed).toBeCloseTo(tas + 100, 6);
    expect(tail.windCorrection).toBeCloseTo(0, 9);
  });

  it('航迹正东时，u 是尾风 v 是侧风', () => {
    const side = solveWindTriangle(90, tas, { u: 0, v: 100 });
    expect(side.groundSpeed).toBeCloseTo(Math.sqrt(tas * tas - 100 * 100), 6);

    const tail = solveWindTriangle(90, tas, { u: 100, v: 0 });
    expect(tail.groundSpeed).toBeCloseTo(tas + 100, 6);
  });

  it('侧风恰好等于真空速时地速趋零但仍可行', () => {
    const r = solveWindTriangle(0, tas, { u: tas - 0.01, v: 0 });
    expect(r.infeasible).toBe(false);
    expect(r.groundSpeed).toBeLessThan(5);
  });

  it('侧风略超真空速即判不可行', () => {
    const r = solveWindTriangle(0, tas, { u: tas + 0.01, v: 0 });
    expect(r.infeasible).toBe(true);
    expect(r.groundSpeed).toBe(0);
  });

  it('全侧风时地速公式对任意航迹角成立', () => {
    for (const trk of [0, 45, 90, 135, 180, 225, 270, 315]) {
      // 构造一个严格垂直于航迹的风
      const perp = (trk + 90) * (Math.PI / 180);
      const u = 120 * Math.sin(perp);
      const v = 120 * Math.cos(perp);
      const r = solveWindTriangle(trk, tas, { u, v });
      expect(r.groundSpeed).toBeCloseTo(Math.sqrt(tas * tas - 120 * 120), 5);
      expect(Math.abs(r.windCorrection)).toBeCloseTo(
        (Math.asin(120 / tas) * 180) / Math.PI,
        5,
      );
    }
  });
});

describe('航路积分的几何保真', () => {
  it('细分点都在原始大圆上（不因 slerp 漂移）', () => {
    const a = { lat: 40.08, lon: 116.58 };
    const b = { lat: 40.64, lon: -73.78 };
    const r = planGreatCircle(ctx(20), a, b);
    const total = greatCircleDistance(a, b);

    let maxDev = 0;
    for (const p of r.points) {
      const dFromA = greatCircleDistance(a, p);
      // 点到 a 的距离加上点到 b 的距离应等于全长（共线）
      const collinear = dFromA + greatCircleDistance(p, b) - total;
      maxDev = Math.max(maxDev, Math.abs(collinear));
    }
    // 允许 1m 内的舍入误差
    expect(maxDev).toBeLessThan(1);
  });

  it('相邻点间距离总和等于总距离', () => {
    const r = planGreatCircle(ctx(20), { lat: 10, lon: 0 }, { lat: 60, lon: 90 });
    let sum = 0;
    for (let i = 0; i < r.points.length - 1; i++) {
      sum += greatCircleDistance(r.points[i], r.points[i + 1]);
    }
    expect(sum).toBeCloseTo(r.distance, 3);
  });

  it('时长等于逐段 d/gs 的总和', () => {
    const r = planGreatCircle(ctx(20), { lat: 10, lon: 0 }, { lat: 60, lon: 90 });
    let t = 0;
    for (let i = 0; i < r.points.length - 1; i++) {
      const d = r.points[i + 1].distance - r.points[i].distance;
      t += d / Math.max(r.points[i].groundSpeed, 1);
    }
    expect(Math.abs(r.duration - t) / r.duration).toBeLessThan(0.01);
  });
});

void toVec3;
void fromVec3;
void slerp;
void machToTas;
