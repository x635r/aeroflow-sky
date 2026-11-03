import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { decodeHalf } from '../src/data/windField';
import type { WindField, WindHeader } from '../src/data/windField';
import {
  planGreatCircle,
  planWindOptimal,
  planRhumb,
  comparePlans,
  catSegments,
  probePoint,
} from '../src/sim/routeEngine';
import type { PlanContext } from '../src/sim/routeEngine';
import { aircraftById, machToTas, pressureToAltitude, solveWindTriangle, ISA } from '../src/core/atmos';
import { greatCircleDistance, greatCircleBulge, toVec3, fromVec3, slerp, EARTH_R_M } from '../src/core/geo';

const dataDir = path.join(__dirname, '..', 'public', 'data');

function loadField(): WindField {
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'wind-manifest.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dataDir, manifest.file));
  const magic = buf.subarray(0, 4).toString();
  const hdrLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.subarray(8, 8 + hdrLen).toString('utf8')) as WindHeader;
  const payload = buf.subarray(8 + hdrLen);
  const u16 = new Uint16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
  const data = decodeHalf(u16);
  const g = header.grid;
  return {
    header,
    data,
    grid: g,
    levels: header.levels.map((l) => l.hPa),
    steps: header.steps.map((s) => s.hour),
    stridePerLevel: g.nLat * g.nLon * 4,
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

describe('大圆几何', () => {
  it('JFK–LHR 距离在教科书范围内', () => {
    const jfk = { lat: 40.6413, lon: -73.7781 };
    const lhr = { lat: 51.47, lon: -0.4614 };
    const d = greatCircleDistance(jfk, lhr) / 1000;
    // 公认值约 5555 km（大圆 5539–5570 之间）
    expect(d).toBeGreaterThan(5500);
    expect(d).toBeLessThan(5600);
  });

  it('对跖点距离等于半周长', () => {
    const a = { lat: 10, lon: 20 };
    const b = { lat: -10, lon: -160 };
    const d = greatCircleDistance(a, b);
    expect(d / (Math.PI * EARTH_R_M)).toBeCloseTo(1.0, 6);
  });

  it('东西向大圆在北半球向北拱起', () => {
    const jfk = { lat: 40.64, lon: -73.78 };
    const lhr = { lat: 51.47, lon: -0.46 };
    const bulge = greatCircleBulge(jfk, lhr);
    expect(bulge).toBeGreaterThan(1.0);
  });

  it('赤道上的东西向航线不拱起', () => {
    const bulge = greatCircleBulge({ lat: 0, lon: 0 }, { lat: 0, lon: 90 });
    expect(Math.abs(bulge)).toBeLessThan(1e-6);
  });

  it('slerp 端点与中点正确', () => {
    const a = toVec3(0, 0);
    const b = toVec3(0, 90);
    const mid = fromVec3(slerp(a, b, 0.5));
    expect(mid.lat).toBeCloseTo(0, 6);
    expect(mid.lon).toBeCloseTo(45, 6);
  });
});

describe('大气与风三角', () => {
  it('标准大气高度与气压互为反函数', () => {
    for (const h of [0, 3000, 10668, 12000, 15000]) {
      const back = pressureToAltitude(pressureHpaOf(h));
      expect(Math.abs(back - h)).toBeLessThan(1.5);
    }
  });

  function pressureHpaOf(h: number): number {
    // 反解用同一套公式的逆
    if (h <= ISA.tropopause) {
      return (ISA.p0 * Math.pow(1 - (ISA.L * h) / ISA.T0, ISA.g0 / (ISA.R * ISA.L))) / 100;
    }
    const pTrop = ISA.p0 * Math.pow(1 - (ISA.L * ISA.tropopause) / ISA.T0, ISA.g0 / (ISA.R * ISA.L));
    return (pTrop * Math.exp((-ISA.g0 * (h - ISA.tropopause)) / (ISA.R * ISA.Ttrop))) / 100;
  }

  it('纯顺风时地速 = 真空速 + 风速', () => {
    // 航迹 90°（正东），风正东 50 m/s
    const r = solveWindTriangle(90, 250, { u: 50, v: 0 });
    expect(r.groundSpeed).toBeCloseTo(300, 3);
    expect(Math.abs(r.windCorrection)).toBeLessThan(1e-6);
    expect(r.headwindComponent).toBeCloseTo(-50, 3);
  });

  it('纯逆风时地速 = 真空速 - 风速', () => {
    const r = solveWindTriangle(90, 250, { u: -50, v: 0 });
    expect(r.groundSpeed).toBeCloseTo(200, 3);
    expect(r.headwindComponent).toBeCloseTo(50, 3);
  });

  it('全侧风时地速下降但航迹可保持', () => {
    const r = solveWindTriangle(90, 250, { u: 0, v: 60 });
    expect(r.groundSpeed).toBeCloseTo(Math.sqrt(250 * 250 - 60 * 60), 3);
    expect(Math.abs(r.windCorrection)).toBeGreaterThan(10);
    expect(r.infeasible).toBe(false);
  });

  it('逆风超过真空速标记为不可行', () => {
    const r = solveWindTriangle(90, 100, { u: -180, v: 0 });
    expect(r.infeasible).toBe(true);
  });

  it('马赫 0.84 在 250 hPa 处真空速合理', () => {
    const probe = probePoint(ctx, 50, -30);
    expect(probe.tas).toBeGreaterThan(220);
    expect(probe.tas).toBeLessThan(260);
    expect(probe.tempC).toBeLessThan(-40);
  });
});

describe('风场采样', () => {
  it('急流核心风速超过 60 m/s', () => {
    let max = 0;
    for (let lat = 20; lat <= 70; lat += 3) {
      for (let lon = -180; lon < 180; lon += 3) {
        const w = probePoint(ctx, lat, lon);
        if (w.speed > max) max = w.speed;
      }
    }
    expect(max).toBeGreaterThan(60);
  });

  it('同一点正反采样结果一致（无状态泄漏）', () => {
    const a = probePoint(ctx, 45, 30);
    const b = probePoint(ctx, 45, 30);
    expect(a.u).toBe(b.u);
    expect(a.v).toBe(b.v);
  });

  it('经度环绕连续：359° 与 -1° 几乎相同', () => {
    const a = probePoint(ctx, 40, 359);
    const b = probePoint(ctx, 40, -1);
    expect(Math.abs(a.u - b.u)).toBeLessThan(1.0);
    expect(Math.abs(a.v - b.v)).toBeLessThan(1.0);
  });

  it('采样无 NaN，温度在物理范围内', () => {
    for (let i = 0; i < 200; i++) {
      const lat = -85 + Math.random() * 170;
      const lon = -180 + Math.random() * 360;
      const w = probePoint(ctx, lat, lon);
      expect(Number.isFinite(w.u)).toBe(true);
      expect(Number.isFinite(w.v)).toBe(true);
      expect(w.tempK).toBeGreaterThan(190);
      expect(w.tempK).toBeLessThan(300);
      expect(w.cat).toBeGreaterThanOrEqual(0);
      expect(w.cat).toBeLessThanOrEqual(1);
    }
  });
});

describe('航线推演', () => {
  const jfk = { lat: 40.6413, lon: -73.7781 };
  const lhr = { lat: 51.47, lon: -0.4614 };

  it('大圆航线的总距离与几何距离一致', () => {
    const gc = planGreatCircle(ctx, jfk, lhr);
    const geo = greatCircleDistance(jfk, lhr);
    expect(Math.abs(gc.distance - geo) / geo).toBeLessThan(0.01);
  });

  it('航路点距离单调不减', () => {
    const gc = planGreatCircle(ctx, jfk, lhr);
    for (let i = 1; i < gc.points.length; i++) {
      expect(gc.points[i].distance).toBeGreaterThanOrEqual(gc.points[i - 1].distance - 1e-6);
    }
  });

  it('借风航线不慢于大圆航线', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    // DP 允许回到大圆路径（中心槽），所以理论上不可能更差；
    // 留 0.5% 余量给离散化误差
    expect(cmp.optimal.duration).toBeLessThanOrEqual(cmp.gc.duration * 1.005);
  });

  it('跨大西洋东行应比西行快', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    const east = cmp.optimal.duration;
    const west = cmp.reverse.duration;
    expect(east).toBeLessThan(west);
    // 真实世界差异通常在 30–90 分钟量级
    const deltaMin = (west - east) / 60;
    expect(deltaMin).toBeGreaterThan(10);
    expect(deltaMin).toBeLessThan(240);
  });

  it('平均地速落在合理区间', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    for (const r of [cmp.gc, cmp.optimal, cmp.reverse]) {
      expect(r.avgGroundSpeed).toBeGreaterThan(120);
      expect(r.avgGroundSpeed).toBeLessThan(400);
    }
  });

  it('飞行时间与真实航班同量级（5–10 小时）', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    const hours = cmp.optimal.duration / 3600;
    expect(hours).toBeGreaterThan(5.0);
    expect(hours).toBeLessThan(10);
  });

  it('借风航线相对大圆的偏离非负且自洽', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    // 2026-10-31 06Z 北大西洋急流偏弱（当天的急流核心在西太平洋），
    // 所以这条航线本来就不该明显绕飞。这里只校验数值自洽。
    expect(cmp.optimal.deviationDeg).toBeGreaterThanOrEqual(0);
    expect(cmp.optimal.deviationDeg).toBeLessThan(30);
  });

  it('恒向线在长航程上略长于大圆', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    expect(cmp.rhumb.distance).toBeGreaterThanOrEqual(cmp.gc.distance * 0.999);
  });

  it('跨太平洋航线可正常求解', () => {
    const sfo = { lat: 37.6213, lon: -122.379 };
    const nrt = { lat: 35.772, lon: 140.392 };
    const cmp = comparePlans(ctx, sfo, nrt);
    expect(cmp.optimal.points.length).toBeGreaterThan(10);
    expect(cmp.optimal.duration / 3600).toBeGreaterThan(8);
    expect(cmp.optimal.duration / 3600).toBeLessThan(16);
    expect(cmp.eastboundGs).toBeGreaterThan(0);
  });

  it('短程航线不会崩溃', () => {
    const a = { lat: 51.47, lon: -0.46 };
    const b = { lat: 48.86, lon: 2.35 };
    const r = planWindOptimal(ctx, a, b, { corridorKm: 120, stations: 20 });
    expect(Number.isFinite(r.duration)).toBe(true);
    expect(r.duration).toBeGreaterThan(0);
    expect(r.duration / 60).toBeLessThan(120);
  });

  it('极区航线（跨北极）可求解', () => {
    const pek = { lat: 40.08, lon: 116.58 };
    const jfk2 = { lat: 40.64, lon: -73.78 };
    const gc = planGreatCircle(ctx, pek, jfk2);
    expect(Number.isFinite(gc.duration)).toBe(true);
    expect(gc.duration / 3600).toBeGreaterThan(8);
    expect(gc.duration / 3600).toBeLessThan(18);
    // 跨极航线视角上会穿过高纬
    const maxLat = Math.max(...gc.points.map((p) => p.lat));
    expect(maxLat).toBeGreaterThan(60);
  });

  it('所有航路点的物理量都在合理范围', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    for (const r of [cmp.gc, cmp.optimal, cmp.rhumb, cmp.reverse]) {
      for (const p of r.points) {
        expect(Number.isFinite(p.lat)).toBe(true);
        expect(Number.isFinite(p.lon)).toBe(true);
        expect(p.groundSpeed).toBeGreaterThan(0);
        expect(p.groundSpeed).toBeLessThan(500);
        expect(p.cat).toBeGreaterThanOrEqual(0);
        expect(p.cat).toBeLessThanOrEqual(1);
      }
    }
  });

  it('CAT 分段不重叠且有序', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    const segs = catSegments(cmp.optimal.points);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end - 1);
    }
  });
});

describe('合成风场：急流借风能力', () => {
  /** 造一个南/北风带：北侧强西风（急流），南侧静风。DP 应该把航线推到北侧。 */
  function makeJetField(): WindField {
    const g = { nLat: 91, nLon: 181, latMin: -90, latMax: 90, lonMin: 0, lonMax: 360 };
    const n = g.nLat * g.nLon * 4;
    const levels = [200, 250, 300];
    const steps = [0];
    const data = new Float32Array(n * levels.length * steps.length);
    for (let l = 0; l < levels.length; l++) {
      for (let iLat = 0; iLat < g.nLat; iLat++) {
        const lat = g.latMin + (180 * iLat) / (g.nLat - 1);
        // 急流带：55°N 附近最强，高斯型剖面
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
      magic: 'AFLW1', generated: '', source: 'synthetic', cycle: '', encoding: 'float16',
      channels: ['u', 'v', 'cat', 'temp'], units: {},
      grid: g,
      levels: levels.map((h) => ({ hPa: h, fl: 300 })),
      steps: [{ hour: 0, validTime: '2026-01-01T00:00:00Z' }],
      layout: '', stats: [], catMethod: '',
    } as WindHeader;
    return { header, data, grid: g, levels, steps, stridePerLevel: g.nLat * g.nLon * 4, stepTimestamps: [Date.now()] };
  }

  const jetCtx: PlanContext = {
    field: makeJetField(),
    pressureHpa: 250,
    stepPos: 0,
    aircraft: aircraftById('b77w'),
    mach: 0.84,
  };

  it('遇到强西风急流时应向北绕飞', () => {
    const from = { lat: 38, lon: -70 };
    const to = { lat: 46, lon: 5 };
    const cmp = comparePlans(jetCtx, from, to, { corridorKm: 900, offsets: 25, stations: 40 });
    // 大圆平均纬度约 42°N；急流在 56°N，最优点重叠处风速更大
    const avgLatOpt = cmp.optimal.points.reduce((s, p) => s + p.lat, 0) / cmp.optimal.points.length;
    const avgLatGc = cmp.gc.points.reduce((s, p) => s + p.lat, 0) / cmp.gc.points.length;
    expect(avgLatOpt).toBeGreaterThan(avgLatGc + 1.0);
    expect(cmp.timeSaved).toBeGreaterThan(120);
  });

  it('急流中平均顺风分量显著为正', () => {
    const cmp = comparePlans(jetCtx, { lat: 38, lon: -70 }, { lat: 46, lon: 5 }, {
      corridorKm: 900, offsets: 25, stations: 40,
    });
    expect(cmp.optimal.avgWindAlong).toBeGreaterThan(20);
    expect(cmp.optimal.avgGroundSpeed).toBeGreaterThan(cmp.gc.avgGroundSpeed);
  });

  it('反向飞时航路会自动避开急流', () => {
    const fwd = planWindOptimal(jetCtx, { lat: 46, lon: 5 }, { lat: 38, lon: -70 }, {
      corridorKm: 900, offsets: 25, stations: 40,
    });
    const rev = planWindOptimal(jetCtx, { lat: 38, lon: -70 }, { lat: 46, lon: 5 }, {
      corridorKm: 900, offsets: 25, stations: 40,
    });
    // 西行受急流阻碍，必然更慢
    expect(fwd.duration).toBeGreaterThan(rev.duration);
    const delta = (fwd.duration - rev.duration) / 60;
    expect(delta).toBeGreaterThan(15);
  });
});

describe('性能', () => {
  it('单次借风推演在 400ms 内完成', () => {
    const jfk = { lat: 40.64, lon: -73.78 };
    const lhr = { lat: 51.47, lon: -0.46 };
    const t0 = performance.now();
    planWindOptimal(ctx, jfk, lhr);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(400);
  });

  it('完整对比在 900ms 内完成', () => {
    const jfk = { lat: 40.64, lon: -73.78 };
    const lhr = { lat: 51.47, lon: -0.46 };
    const t0 = performance.now();
    comparePlans(ctx, jfk, lhr);
    expect(performance.now() - t0).toBeLessThan(900);
  });
});
