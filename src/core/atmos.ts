/**
 * 飞行力学：真速 / 地速 / 风三角 / ISA 大气 / Mach
 * ---------------------------------------------------------------------------
 * 这是整个产品的「物理真相层」：所有「借风」叙事都必须由这里的三角关系支撑。
 *
 *   ┌ 航迹角 TRK（地速方向）
 *   │
 *   ├── 地速矢量 GS  = TAS 矢量 + 风矢量 W
 *   │
 *   └ 航向 HDG（机头指向）= TRK - 偏流角 WCA
 *
 * 风三角（wind triangle）：
 *   GS·sin(TRK) = TAS·sin(HDG) + W_east
 *   GS·cos(TRK) = TAS·cos(HDG) + W_north
 */

import { DEG, RAD, clamp } from './geo';

export type Wind = { u: number; v: number }; // m/s，u 向东，v 向北

/** 标准大气参数（ISA） */
export const ISA = {
  T0: 288.15, // K, 海平面
  p0: 101325, // Pa
  L: 0.0065, // K/m, 对流层温度梯度
  R: 287.05287, // J/(kg·K)
  g0: 9.80665,
  gamma: 1.4,
  /** 对流层顶 11 km 以上为等温层 */
  tropopause: 11000,
  Ttrop: 216.65,
} as const;

/**
 * 气压面 → 标准大气高度（米）。
 * 分两层求解：对流层用温度递减公式，11 km 以上用等温层。25–40 km 的慢变可以忽略。
 */
export function pressureToAltitude(pressureHpa: number): number {
  const p = pressureHpa * 100;
  const pTrop = ISA.p0 * Math.pow(1 - (ISA.L * ISA.tropopause) / ISA.T0, ISA.g0 / (ISA.R * ISA.L));

  if (p >= pTrop) {
    const expo = ISA.R * ISA.L / ISA.g0;
    return (ISA.T0 / ISA.L) * (1 - Math.pow(p / ISA.p0, expo));
  }
  // 等温层：h = h_trop + (R·T_trop/g)·ln(p_trop/p)
  return ISA.tropopause + (ISA.R * ISA.Ttrop / ISA.g0) * Math.log(pTrop / p);
}

/** 标准大气高度 → 气压（hPa） */
export function altitudeToPressure(altitudeM: number): number {
  if (altitudeM <= ISA.tropopause) {
    const p = ISA.p0 * Math.pow(1 - (ISA.L * altitudeM) / ISA.T0, ISA.g0 / (ISA.R * ISA.L));
    return p / 100;
  }
  // 等温层
  const pTrop = ISA.p0 * Math.pow(1 - (ISA.L * ISA.tropopause) / ISA.T0, ISA.g0 / (ISA.R * ISA.L));
  const p = pTrop * Math.exp((-ISA.g0 * (altitudeM - ISA.tropopause)) / (ISA.R * ISA.Ttrop));
  return p / 100;
}

/** 米 → 飞行高度层（FL，百英尺） */
export function metersToFlightLevel(m: number): number {
  return Math.round(m / 0.3048 / 100);
}

export function flightLevelToMeters(fl: number): number {
  return fl * 100 * 0.3048;
}

/** 标准大气温度（K） */
export function isaTemperature(altitudeM: number): number {
  if (altitudeM <= ISA.tropopause) return ISA.T0 - ISA.L * altitudeM;
  return ISA.Ttrop;
}

/** 当地音速（m/s），给定静温 */
export function speedOfSound(tempK: number): number {
  return Math.sqrt(ISA.gamma * ISA.R * tempK);
}

/** 马赫数 → 真空速（m/s），给定静温 */
export function machToTas(mach: number, tempK: number): number {
  return mach * speedOfSound(tempK);
}

/** 真空速 → 马赫 */
export function tasToMach(tas: number, tempK: number): number {
  return tas / speedOfSound(tempK);
}

export function msToKmh(ms: number): number {
  return ms * 3.6;
}

export function msToKt(ms: number): number {
  return ms * 1.9438444924;
}

export function kmhToMs(kmh: number): number {
  return kmh / 3.6;
}

/**
 * 风三角求解：给定目标航迹、真空速、风，求地速与偏流角。
 *
 * 用解析解而非迭代，保证在 UI 里每帧调用也不会有数值抖动。
 * 若风速 > 真空速且完全逆风，地速会被夹到极小正值并标记 infeasible。
 */
export type WindTriangleResult = {
  /** 地速 m/s */
  groundSpeed: number;
  /** 偏流角（度），正值为右偏 */
  windCorrection: number;
  /** 航向（度） */
  heading: number;
  /** 顺风分量 m/s（沿航迹，正为顺风） */
  headwindComponent: number;
  /** 侧风分量 m/s（垂直于航迹，正为右侧） */
  crosswindComponent: number;
  /** 逆风过强，无法维持航迹 */
  infeasible: boolean;
};

export function solveWindTriangle(
  trackDeg: number,
  trueAirspeed: number,
  wind: Wind,
): WindTriangleResult {
  const trk = trackDeg * DEG;

  // 把风分解到航迹坐标系：沿航迹分量 + 垂直航迹分量
  const along = wind.u * Math.sin(trk) + wind.v * Math.cos(trk);
  const crossw = wind.u * Math.cos(trk) - wind.v * Math.sin(trk);

  // 机头必须在「航迹反方向的风来向」一侧补偿
  // GS 沿航迹方向满足：GS = TAS·cos(WCA) + along
  // 横侧满足：0 = TAS·sin(WCA) + cross   ⇒ sin(WCA) = -cross / TAS
  const sinWca = clamp(-crossw / Math.max(trueAirspeed, 1e-6), -1, 1);
  const wca = Math.asin(sinWca);
  const cosWca = Math.cos(wca);

  let groundSpeed = trueAirspeed * cosWca + along;
  let infeasible = false;
  if (groundSpeed < 1) {
    // 逆风超过真空速：物理上无法沿该航迹前进
    groundSpeed = Math.max(groundSpeed, 0.5);
    infeasible = true;
  }

  return {
    groundSpeed,
    windCorrection: wca * RAD,
    heading: (trackDeg + wca * RAD + 360) % 360,
    headwindComponent: -along,
    crosswindComponent: -crossw,
    infeasible,
  };
}

/**
 * 给定航向与真空速，反求实际航迹与地速（真实飞行时飞行员保持航向的情况）。
 */
export function solveTrackFromHeading(
  headingDeg: number,
  trueAirspeed: number,
  wind: Wind,
): { track: number; groundSpeed: number } {
  const hdg = headingDeg * DEG;
  const ve = trueAirspeed * Math.sin(hdg) + wind.u;
  const vn = trueAirspeed * Math.cos(hdg) + wind.v;
  return {
    track: (Math.atan2(ve, vn) * RAD + 360) % 360,
    groundSpeed: Math.hypot(ve, vn),
  };
}

/**
 * 常见机型巡航性能档案。用于推演的默认值，
 * 数值取自各机型公开的典型巡航马赫数与高度。
 */
export type AircraftProfile = {
  id: string;
  name: string;
  shortName: string;
  /** 典型巡航马赫 */
  cruiseMach: number;
  /** 典型巡航高度（米） */
  cruiseAltM: number;
  /** 最大航程 km */
  rangeKm: number;
  /** 座位数 */
  seats: number;
  /** 类别，用于配色 */
  category: 'widebody' | 'narrowbody' | 'regional' | 'cargo';
  /** 用于对比展示的尾翼注册示例 */
  examples: string[];
};

export const AIRCRAFT: AircraftProfile[] = [
  {
    id: 'b77w',
    name: 'Boeing 777-300ER',
    shortName: 'B77W',
    cruiseMach: 0.84,
    cruiseAltM: 10_700,
    rangeKm: 13_649,
    seats: 396,
    category: 'widebody',
    examples: ['N2331U', 'B-2022', 'G-STBA'],
  },
  {
    id: 'a350',
    name: 'Airbus A350-900',
    shortName: 'A359',
    cruiseMach: 0.85,
    cruiseAltM: 11_300,
    rangeKm: 15_000,
    seats: 325,
    category: 'widebody',
    examples: ['B-304D', 'A7-ALH', '9V-SMA'],
  },
  {
    id: 'b789',
    name: 'Boeing 787-9',
    shortName: 'B789',
    cruiseMach: 0.85,
    cruiseAltM: 11_300,
    rangeKm: 14_140,
    seats: 296,
    category: 'widebody',
    examples: ['G-ZBKA', 'JA873A', 'N26902'],
  },
  {
    id: 'a333',
    name: 'Airbus A330-300',
    shortName: 'A333',
    cruiseMach: 0.82,
    cruiseAltM: 10_700,
    rangeKm: 11_750,
    seats: 277,
    category: 'widebody',
    examples: ['B-HLU', 'EI-EIN', '9M-MTE'],
  },
  {
    id: 'b738',
    name: 'Boeing 737-800',
    shortName: 'B738',
    cruiseMach: 0.785,
    cruiseAltM: 10_400,
    rangeKm: 5_436,
    seats: 189,
    category: 'narrowbody',
    examples: ['B-5175', 'N372DA', 'EI-EMN'],
  },
  {
    id: 'a21n',
    name: 'Airbus A321neo',
    shortName: 'A21N',
    cruiseMach: 0.78,
    cruiseAltM: 10_400,
    rangeKm: 7_400,
    seats: 220,
    category: 'narrowbody',
    examples: ['B-30EU', 'G-TNEA', 'N402DX'],
  },
];

export function aircraftById(id: string): AircraftProfile {
  return AIRCRAFT.find((a) => a.id === id) ?? AIRCRAFT[0];
}

/**
 * 该机型在指定高度、给定静温下的巡航真空速（m/s）。
 * 高空巡航通常按固定马赫数，气温低 → 真空速低。
 */
export function cruiseTas(profile: AircraftProfile, tempK: number): number {
  return machToTas(profile.cruiseMach, tempK);
}

/**
 * 爬升/下降的简化模型：线性爬升率 + 水平速度折减。
 * 只用于把航路剖面画得可信，不参与"最高分"计算。
 */
export function climbProfile(profile: AircraftProfile): { climbRate: number; descentRate: number; speedFactor: number } {
  return {
    climbRate: profile.cruiseAltM / 22 / 60, // ~22 分钟爬升到巡航高度
    descentRate: profile.cruiseAltM / 26 / 60,
    speedFactor: 0.78,
  };
}

/** 航段飞行时间（秒） */
export function legTime(distanceM: number, groundSpeedMs: number): number {
  return distanceM / Math.max(groundSpeedMs, 0.5);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} 分`;
  return `${h} 小时 ${String(m).padStart(2, '0')} 分`;
}

export function formatHm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
