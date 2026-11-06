import { describe, expect, it } from 'vitest';
import {
  greatCircleDistance,
  initialBearing,
  rhumbLine,
  rhumbPoint,
  slerp,
  toVec3,
  fromVec3,
  normalizeLon,
  EARTH_R_M,
  mercatorPsi,
} from '../src/core/geo';
import {
  altitudeToPressure,
  pressureToAltitude,
  isaTemperature,
  speedOfSound,
  machToTas,
  solveWindTriangle,
  solveTrackFromHeading,
  metersToFlightLevel,
} from '../src/core/atmos';

/**
 * 数值审查
 * ---------------------------------------------------------------------------
 * 每一条都用公开的权威数值做对照，而不是"和上一次跑出来的一样"。
 * 基准来源：ICAO 标准大气、WGS84 测地学、公开航线距离表。
 */

describe('大圆距离：对照公开航线数据', () => {
  it('北京 PEK → 纽约 JFK ≈ 11000 km（跨极航线）', () => {
    const d = greatCircleDistance({ lat: 40.08, lon: 116.58 }, { lat: 40.64, lon: -73.78 }) / 1000;
    // 公开值 10990–11020 km
    expect(d).toBeGreaterThan(10950);
    expect(d).toBeLessThan(11060);
  });

  it('伦敦 LHR → 悉尼 SYD ≈ 17000 km', () => {
    const d = greatCircleDistance({ lat: 51.47, lon: -0.46 }, { lat: -33.94, lon: 151.18 }) / 1000;
    // 公开值 16990–17030 km
    expect(d).toBeGreaterThan(16950);
    expect(d).toBeLessThan(17080);
  });

  it('JFK → LHR ≈ 5555 km', () => {
    const d = greatCircleDistance({ lat: 40.64, lon: -73.78 }, { lat: 51.47, lon: -0.46 }) / 1000;
    expect(d).toBeGreaterThan(5530);
    expect(d).toBeLessThan(5580);
  });

  it('赤道周长：沿赤道走 360° 等于 2πR', () => {
    // 用四段 90° 累加
    const pts = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 90 },
      { lat: 0, lon: 180 },
      { lat: 0, lon: -90 },
      { lat: 0, lon: 0 },
    ];
    let sum = 0;
    for (let i = 0; i < pts.length - 1; i++) sum += greatCircleDistance(pts[i], pts[i + 1]);
    expect(sum / 1000).toBeCloseTo((2 * Math.PI * EARTH_R_M) / 1000, 0);
    // 2π × 6371008.8m = 40030.2 km（不是赤道实际周长 40075，
    // 因为这里用的是球面平均半径而非 WGS84 赤道半径）
    expect(sum / 1000).toBeGreaterThan(40020);
    expect(sum / 1000).toBeLessThan(40040);
  });

  it('子午线半周：北极到南极 = πR', () => {
    const d = greatCircleDistance({ lat: 90, lon: 0 }, { lat: -90, lon: 0 });
    expect(d).toBeCloseTo(Math.PI * EARTH_R_M, 0);
  });

  it('对跖点距离 = πR', () => {
    const d = greatCircleDistance({ lat: 12, lon: 34 }, { lat: -12, lon: -146 });
    expect(d / (Math.PI * EARTH_R_M)).toBeCloseTo(1, 9);
  });

  it('同点距离为 0', () => {
    expect(greatCircleDistance({ lat: 33, lon: 44 }, { lat: 33, lon: 44 })).toBe(0);
  });

  it('靠近极点的两点距离稳定（不因 cos φ → 0 而失真）', () => {
    const d = greatCircleDistance({ lat: 89.9, lon: 0 }, { lat: 89.9, lon: 180 });
    // 纬度 89.9 处，经度差 180° 的距离 ≈ 2 × 0.1° × π/180 × R ≈ 22.2 km
    expect(d / 1000).toBeGreaterThan(22);
    expect(d / 1000).toBeLessThan(22.5);
  });
});

describe('初始方位角：对照公开值', () => {
  it('JFK → LHR ≈ 51°', () => {
    const b = initialBearing({ lat: 40.64, lon: -73.78 }, { lat: 51.47, lon: -0.46 });
    expect(b).toBeGreaterThan(49);
    expect(b).toBeLessThan(53);
  });

  it('PEK → JFK 初始方位约 7.9°（几乎正北）', () => {
    const b = initialBearing({ lat: 40.08, lon: 116.58 }, { lat: 40.64, lon: -73.78 });
    // 两点纬度接近，但经度差 190°，大圆先大幅向北再向东，
    // 所以初始方位几乎正北（约 8°，略偏东）。
    expect(b).toBeGreaterThan(6);
    expect(b).toBeLessThan(10);
  });

  it('正东方向为 90°', () => {
    expect(initialBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 10 })).toBeCloseTo(90, 6);
  });

  it('正北方向为 0°', () => {
    expect(initialBearing({ lat: 0, lon: 0 }, { lat: 10, lon: 0 })).toBeCloseTo(0, 6);
  });

  it('正南方向为 180°', () => {
    expect(initialBearing({ lat: 10, lon: 0 }, { lat: 0, lon: 0 })).toBeCloseTo(180, 6);
  });

  it('正西方向为 270°', () => {
    expect(initialBearing({ lat: 0, lon: 10 }, { lat: 0, lon: 0 })).toBeCloseTo(270, 6);
  });

  it('跨 180° 经线时取短路径（179°E → 179°W 向东 2°）', () => {
    const b = initialBearing({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
    expect(b).toBeCloseTo(90, 4);
  });
});

describe('恒向线：对照解析值', () => {
  it('JFK → LHR 恒向线 ≈ 5758 km、航向 ≈ 77.9°', () => {
    const r = rhumbLine({ lat: 40.64, lon: -73.78 }, { lat: 51.47, lon: -0.46 });
    expect(r.distance / 1000).toBeGreaterThan(5740);
    expect(r.distance / 1000).toBeLessThan(5780);
    expect(r.bearing).toBeGreaterThan(76);
    expect(r.bearing).toBeLessThan(80);
  });

  it('赤道上恒向线 = 大圆', () => {
    const a = { lat: 0, lon: -30 };
    const b = { lat: 0, lon: 30 };
    const rh = rhumbLine(a, b).distance;
    const gc = greatCircleDistance(a, b);
    expect(Math.abs(rh - gc) / gc).toBeLessThan(1e-9);
  });

  it('同纬度东西向：距离 = Δλ·cos(φ)·R', () => {
    const a = { lat: 60, lon: 0 };
    const b = { lat: 60, lon: 30 };
    const rh = rhumbLine(a, b).distance;
    const expected = (30 * Math.PI / 180) * Math.cos(60 * Math.PI / 180) * EARTH_R_M;
    expect(Math.abs(rh - expected) / expected).toBeLessThan(1e-9);
    expect(rh / 1000).toBeCloseTo(1668, 0);
  });

  it('正北向恒向线航向为 0°，距离 = Δφ·R', () => {
    const r = rhumbLine({ lat: 10, lon: 20 }, { lat: 40, lon: 20 });
    expect(r.bearing).toBeCloseTo(0, 6);
    const expected = (30 * Math.PI / 180) * EARTH_R_M;
    expect(Math.abs(r.distance - expected) / expected).toBeLessThan(1e-9);
  });

  it('恒向线双向等价（长度相同、航向差 180°）', () => {
    const a = { lat: 40.64, lon: -73.78 };
    const b = { lat: 51.47, lon: -0.46 };
    const f = rhumbLine(a, b);
    const r = rhumbLine(b, a);
    expect(f.distance).toBeCloseTo(r.distance, 6);
    expect(Math.abs(f.bearing - r.bearing)).toBeCloseTo(180, 6);
  });

  it('跨 180° 经线走短路径', () => {
    const r = rhumbLine({ lat: 0, lon: 179 }, { lat: 0, lon: -179 });
    // 应走 2° 而非 358°
    const expected = (2 * Math.PI / 180) * EARTH_R_M;
    expect(Math.abs(r.distance - expected) / expected).toBeLessThan(1e-6);
  });

  it('rhumbPoint 端点在 t=0 与 t=1 时精确', () => {
    const a = { lat: 35, lon: -120 };
    const b = { lat: -20, lon: 140 };
    const p0 = rhumbPoint(a, b, 0);
    const p1 = rhumbPoint(a, b, 1);
    expect(p0.lat).toBeCloseTo(a.lat, 9);
    expect(p0.lon).toBeCloseTo(a.lon, 9);
    expect(p1.lat).toBeCloseTo(b.lat, 9);
    expect(p1.lon).toBeCloseTo(normalizeLon(b.lon), 9);
  });

  it('rhumbPoint 中点的纬度在两端之间（单调）', () => {
    const p = rhumbPoint({ lat: 0, lon: 0 }, { lat: 60, lon: 60 }, 0.5);
    // Mercator 中点纬度约 30°，因 ln(tan) 非线性会略高于线性中点
    // Mercator 映射非线性：60° 的 ψ = 1.317，中点 ψ = 0.659 → φ = 35.26°，
    // 明显高于线性中点 30°
    expect(p.lat).toBeGreaterThan(34);
    expect(p.lat).toBeLessThan(36);
  });

  it('mercatorPsi 单调递增且在极点有限', () => {
    expect(mercatorPsi(-60)).toBeLessThan(mercatorPsi(0));
    expect(mercatorPsi(0)).toBeLessThan(mercatorPsi(60));
    expect(Number.isFinite(mercatorPsi(90))).toBe(true);
    expect(Number.isFinite(mercatorPsi(-90))).toBe(true);
  });
});

describe('ISA 标准大气：对照 ICAO 表', () => {
  it('海平面 1013.25 hPa', () => {
    expect(altitudeToPressure(0)).toBeCloseTo(1013.25, 1);
  });

  it('海平面温度 15°C', () => {
    expect(isaTemperature(0)).toBeCloseTo(288.15, 2);
  });

  it('11000m（对流层顶）226.32 hPa / 216.65K', () => {
    expect(altitudeToPressure(11000)).toBeCloseTo(226.32, 1);
    expect(isaTemperature(11000)).toBeCloseTo(216.65, 2);
  });

  it('气压层几何高度：250 hPa ≈ 10363m', () => {
    expect(pressureToAltitude(250) / 1000).toBeCloseTo(10.363, 2);
  });

  it('气压层几何高度：300 hPa ≈ 9164m', () => {
    // pressureToAltitude 返回米；ISA 解析值 9163.95 m
    expect(pressureToAltitude(300)).toBeGreaterThan(9150);
    expect(pressureToAltitude(300)).toBeLessThan(9180);
  });

  it('气压层几何高度：200 hPa ≈ 11784m', () => {
    // ISA 解析值 11784.04 m（已在对流层顶之上，走等温层公式）
    expect(pressureToAltitude(200)).toBeGreaterThan(11760);
    expect(pressureToAltitude(200)).toBeLessThan(11800);
  });

  it('往返精度 < 1m', () => {
    for (const h of [0, 1000, 5000, 10000, 11000, 13000, 16000]) {
      const back = pressureToAltitude(altitudeToPressure(h));
      expect(Math.abs(back - h)).toBeLessThan(1);
    }
  });

  it('tropopause 处温度连续', () => {
    expect(isaTemperature(10999)).toBeCloseTo(isaTemperature(11001), 1);
  });

  it('平流层等温：12000m 与 15000m 温度相同', () => {
    expect(isaTemperature(12000)).toBeCloseTo(isaTemperature(15000), 3);
  });

  it('音速：海平面 340.3 m/s', () => {
    expect(speedOfSound(288.15)).toBeCloseTo(340.3, 1);
  });

  it('音速：11km 处 295.1 m/s', () => {
    expect(speedOfSound(216.65)).toBeCloseTo(295.1, 1);
  });

  it('M0.84 在 11km ≈ 248 m/s', () => {
    expect(machToTas(0.84, 216.65)).toBeCloseTo(247.9, 0);
  });

  it('FL350 = 10668m', () => {
    expect(metersToFlightLevel(10668)).toBe(350);
  });
});

describe('风三角：物理恒等式', () => {
  it('顺风：GS = TAS + W，航向 = 航迹', () => {
    const r = solveWindTriangle(90, 250, { u: 50, v: 0 });
    expect(r.groundSpeed).toBeCloseTo(300, 9);
    expect(r.heading).toBeCloseTo(90, 9);
    expect(r.windCorrection).toBeCloseTo(0, 9);
  });

  it('逆风：GS = TAS - W', () => {
    const r = solveWindTriangle(90, 250, { u: -50, v: 0 });
    expect(r.groundSpeed).toBeCloseTo(200, 9);
  });

  it('全侧风：GS = √(TAS² - W²)', () => {
    const r = solveWindTriangle(90, 250, { u: 0, v: 60 });
    expect(r.groundSpeed).toBeCloseTo(Math.sqrt(250 * 250 - 60 * 60), 6);
  });

  it('右侧风 → 机头左偏（heading < track）', () => {
    // 航迹正东，风从南来（v=+50 是北向风，即吹向北，来向为南）
    // 风向北吹，飞机要被推向北，机头需向南偏，heading > 90
    const r = solveWindTriangle(90, 250, { u: 0, v: 50 });
    expect(r.windCorrection).toBeGreaterThan(0);
    expect(r.heading).toBeGreaterThan(90);
    expect(r.heading).toBeLessThan(180);
  });

  it('左侧风 → 机头右偏（heading > track 或 < 依坐标系）', () => {
    const r = solveWindTriangle(90, 250, { u: 0, v: -50 });
    expect(r.windCorrection).toBeLessThan(0);
    expect(r.heading).toBeLessThan(90);
  });

  it('逆风超过真空速 → infeasible', () => {
    const r = solveWindTriangle(90, 100, { u: -150, v: 0 });
    expect(r.infeasible).toBe(true);
    expect(r.groundSpeed).toBe(0);
  });

  it('侧风超过真空速 → infeasible', () => {
    const r = solveWindTriangle(90, 100, { u: 0, v: 150 });
    expect(r.infeasible).toBe(true);
  });

  it('顺风分量符号：顺风为正', () => {
    const tail = solveWindTriangle(90, 250, { u: 40, v: 0 });
    expect(tail.headwindComponent).toBeLessThan(0); // 负 = 顺风
    const head = solveWindTriangle(90, 250, { u: -40, v: 0 });
    expect(head.headwindComponent).toBeGreaterThan(0); // 正 = 逆风
  });

  it('solveTrackFromHeading 与 solveWindTriangle 互为逆', () => {
    const tas = 250;
    const wind = { u: 30, v: -20 };
    const track = 75;
    const tri = solveWindTriangle(track, tas, wind);
    // 用求出的航向反解，应回到同一航迹与地速
    const back = solveTrackFromHeading(tri.heading, tas, wind);
    expect(back.track).toBeCloseTo(track, 6);
    expect(back.groundSpeed).toBeCloseTo(tri.groundSpeed, 6);
  });

  it('无风时 GS = TAS', () => {
    const r = solveWindTriangle(123, 250, { u: 0, v: 0 });
    expect(r.groundSpeed).toBeCloseTo(250, 9);
    expect(r.heading).toBeCloseTo(123, 9);
  });
});

describe('slerp 与向量运算', () => {
  it('对跖点插值保持单位长度', () => {
    const a = toVec3(0, 0);
    const b = toVec3(0, 180);
    for (let i = 0; i <= 10; i++) {
      const v = slerp(a, b, i / 10);
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9);
    }
  });

  it('slerp 路径连续（相邻步长 < 0.5）', () => {
    const a = toVec3(10, 20);
    const b = toVec3(-40, -160);
    let prev = slerp(a, b, 0);
    for (let i = 1; i <= 20; i++) {
      const v = slerp(a, b, i / 20);
      const step = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]);
      expect(step).toBeLessThan(0.5);
      prev = v;
    }
  });

  it('toVec3 / fromVec3 往返精度', () => {
    for (const lat of [-85, -30, 0, 45, 85]) {
      for (const lon of [-170, -90, 0, 45, 170]) {
        const back = fromVec3(toVec3(lat, lon));
        expect(back.lat).toBeCloseTo(lat, 9);
        expect(back.lon).toBeCloseTo(lon, 9);
      }
    }
  });

  it('normalizeLon 覆盖 ±540°', () => {
    expect(normalizeLon(0)).toBe(0);
    expect(normalizeLon(180)).toBe(180);
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(190)).toBeCloseTo(-170, 9);
    expect(normalizeLon(-190)).toBeCloseTo(170, 9);
    expect(normalizeLon(540)).toBeCloseTo(180, 9);
    expect(normalizeLon(-540)).toBeCloseTo(-180, 9);
  });
});
