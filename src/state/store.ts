/**
 * 全局状态
 * ---------------------------------------------------------------------------
 * 用 zustand 而不是 context：推演参数变化会触发几处互相独立的更新
 * （风场纹理、航线、图表、指标卡），用选择器订阅可以精确控制重渲染范围。
 */

import { create } from 'zustand';
import { aircraftById, type AircraftProfile } from '../core/atmos';
import type { WindField, WindManifest } from '../data/windField';
import { timeToStepPos, pressureToLevelPos } from '../data/windField';
import { comparePlans, type Comparison, type PlanContext } from '../sim/routeEngine';
import type { LatLon } from '../core/geo';

export type Airport = {
  iata: string;
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  tz: string;
  degree?: number;
};

export type LayerState = {
  jet: boolean;
  gc: boolean;
  rhumb: boolean;
  cat: boolean;
  grid: boolean;
};

export type LoadingStage =
  | { stage: 'idle' }
  | { stage: 'wind'; progress: number }
  | { stage: 'static'; progress: number }
  | { stage: 'ready' }
  | { stage: 'error'; message: string };

type State = {
  // ---- 数据 ----
  field: WindField | null;
  manifest: WindManifest | null;
  airports: Airport[];
  airportsByIata: Map<string, Airport>;
  loading: LoadingStage;

  // ---- 推演参数 ----
  from: Airport | null;
  to: Airport | null;
  aircraftId: string;
  mach: number;
  cruiseAltM: number;
  /** 当前气压层（hPa） */
  pressureHpa: number;
  /** 当前预报时间（Unix ms） */
  timeMs: number;
  layers: LayerState;
  /** 是否显示反向（回程）推演 */
  showReturn: boolean;

  // ---- 结果 ----
  result: Comparison | null;
  planning: boolean;

  // ---- HUD ----
  hover: { lat: number; lon: number } | null;
  fps: number;
  showIntro: boolean;
  activeSheet: 'none' | 'fleet' | 'data' | 'about';

  // ---- 动作 ----
  setLoad: (l: LoadingStage) => void;
  initData: (field: WindField, manifest: WindManifest, airports: Airport[]) => void;
  setEndpoints: (from: Airport | null, to: Airport | null) => void;
  setAircraft: (id: string) => void;
  setMach: (m: number) => void;
  setCruiseAlt: (m: number) => void;
  setPressure: (hPa: number) => void;
  setTime: (ms: number) => void;
  toggleLayer: (k: keyof LayerState) => void;
  toggleReturn: () => void;
  recompute: () => void;
  setHover: (h: { lat: number; lon: number } | null) => void;
  setFps: (n: number) => void;
  dismissIntro: () => void;
  setSheet: (s: State['activeSheet']) => void;
  swapEndpoints: () => void;
  planContext: () => PlanContext | null;
};

// 未压缩的 compute 放在模块级，避免 store 里塞长函数体
function computePlan(
  field: WindField,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  pressureHpa: number,
  timeMs: number,
  aircraft: AircraftProfile,
  mach: number,
): Comparison {
  const ctx: PlanContext = {
    field,
    pressureHpa,
    stepPos: timeToStepPos(field, timeMs),
    aircraft,
    mach,
  };
  return comparePlans(ctx, from as LatLon, to as LatLon, {
    corridorKm: 680,
    offsets: 19,
    stations: 34,
  });
}

export const useStore = create<State>((set, get) => ({
  field: null,
  manifest: null,
  airports: [],
  airportsByIata: new Map(),
  loading: { stage: 'idle' },

  from: null,
  to: null,
  aircraftId: 'b77w',
  mach: 0.84,
  cruiseAltM: 10_700,
  pressureHpa: 250,
  timeMs: Date.now(),
  layers: { jet: true, gc: true, rhumb: false, cat: true, grid: false },
  showReturn: false,

  result: null,
  planning: false,

  hover: null,
  fps: 60,
  showIntro: true,
  activeSheet: 'none',

  setLoad: (loading) => set({ loading }),

  initData: (field, manifest, airports) => {
    const map = new Map(airports.map((a) => [a.iata, a]));
    const first = Date.parse(manifest.header.steps[0]?.validTime ?? new Date().toISOString());
    set({
      field,
      manifest,
      airports,
      airportsByIata: map,
      timeMs: Number.isFinite(first) ? first : Date.now(),
      loading: { stage: 'ready' },
    });
  },

  setEndpoints: (from, to) => {
    set({ from, to, planning: true });
    // 用微任务把重算排到一帧之后，让 React 先把 planning 状态渲染出去。
    // 这里刻意不用 requestAnimationFrame：在被遮挡/无头的窗格里 Chromium
    // 会把它节流到几乎不触发，导致重算永远不执行（实测踩过）。
    queueMicrotask(() => get().recompute());
  },

  setAircraft: (id) => {
    const p = aircraftById(id);
    set({ aircraftId: id, mach: p.cruiseMach, cruiseAltM: p.cruiseAltM, planning: true });
    queueMicrotask(() => get().recompute());
  },

  setMach: (m) => {
    set({ mach: m, planning: true });
    queueMicrotask(() => get().recompute());
  },

  setCruiseAlt: (m) => {
    set({ cruiseAltM: m, planning: true });
    queueMicrotask(() => get().recompute());
  },

  setPressure: (hPa) => {
    set({ pressureHpa: hPa });
  },

  setTime: (ms) => set({ timeMs: ms }),

  toggleLayer: (k) =>
    set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),

  toggleReturn: () => set((s) => ({ showReturn: !s.showReturn })),

  recompute: () => {
    const s = get();
    if (!s.field || !s.from || !s.to) {
      set({ planning: false, result: null });
      return;
    }
    try {
      const res = computePlan(
        s.field,
        s.from,
        s.to,
        s.pressureHpa,
        s.timeMs,
        aircraftById(s.aircraftId),
        s.mach,
      );
      set({ result: res, planning: false });
    } catch (e) {
      console.error('[plan] 推演失败', e);
      set({ planning: false });
    }
  },

  setHover: (hover) => set({ hover }),
  setFps: (fps) => set({ fps }),
  dismissIntro: () => set({ showIntro: false }),
  setSheet: (activeSheet) => set({ activeSheet }),
  swapEndpoints: () => {
    const { from, to } = get();
    set({ from: to, to: from, planning: true });
    queueMicrotask(() => get().recompute());
  },

  planContext: () => {
    const s = get();
    if (!s.field) return null;
    return {
      field: s.field,
      pressureHpa: s.pressureHpa,
      stepPos: timeToStepPos(s.field, s.timeMs),
      aircraft: aircraftById(s.aircraftId),
      mach: s.mach,
    };
  },
}));

/** 便捷派生：层索引 */
export function levelPosOf(field: WindField, hPa: number): number {
  return pressureToLevelPos(field, hPa);
}
