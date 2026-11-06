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
import type { LiveSnapshot } from '../data/liveFlights';
import { EMPTY_FILTER, type FlightFilter } from '../data/flightFilter';

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
  /** 飞机图标 */
  aircraft: boolean;
  /** 尾迹 */
  trails: boolean;
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

  // ---- 实时航班 ----
  /** 最近一次拉取的航班快照（含来源标识） */
  liveSnapshot: LiveSnapshot | null;
  liveLoading: boolean;
  /** 选中的航班呼号（用于详情面板与渲染高亮） */
  selectedFlight: string | null;
  /** 航班筛选条件 */
  flightFilter: FlightFilter;
  /** 选中的机场（IATA），用于机场看板 */
  selectedAirport: string | null;
  /** 筛选面板是否打开 */
  filterOpen: boolean;
  /** 全局搜索是否打开 */
  searchOpen: boolean;
  /** 是否显示机场点图层 */
  showAirports: boolean;
  /** 测距工具：已点选的两个点 */
  rulerPoints: Array<{ lat: number; lon: number; label?: string }>;
  /** 测距模式：开启后点击地球会添加测距点而不是选机场 */
  rulerMode: boolean;

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
  selectFlight: (callsign: string | null) => void;
  setFlightFilter: (f: FlightFilter) => void;
  patchFlightFilter: (patch: Partial<FlightFilter>) => void;
  resetFlightFilter: () => void;
  selectAirport: (iata: string | null) => void;
  toggleFilterPanel: () => void;
  setSearchOpen: (v: boolean) => void;
  setLiveSnapshot: (s: LiveSnapshot | null) => void;
  setLiveLoading: (v: boolean) => void;
  /** 按呼号取当前选中的航班对象 */
  toggleAirports: () => void;
  addRulerPoint: (p: { lat: number; lon: number; label?: string }) => void;
  clearRuler: () => void;
  toggleRulerMode: () => void;
  setFps: (n: number) => void;
  dismissIntro: () => void;
  setSheet: (s: State['activeSheet']) => void;
  swapEndpoints: () => void;
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
  layers: { jet: true, gc: true, rhumb: false, cat: true, grid: false, aircraft: true, trails: true },
  showReturn: false,

  result: null,
  planning: false,

  liveSnapshot: null,
  liveLoading: false,
  selectedFlight: null,
  flightFilter: EMPTY_FILTER,
  selectedAirport: null,
  filterOpen: false,
  searchOpen: false,
  showAirports: true,
  rulerPoints: [],
  rulerMode: false,

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
      // 必须清空：否则界面会显示「新机场 + 上一次的航线数据」，
      // 标题是新的起降点，数字却是旧的，比直接报错更误导。
      set({ planning: false, result: null });
    }
  },

  setHover: (hover) => set({ hover }),

  selectFlight: (callsign) =>
    set((s) => ({ selectedFlight: s.selectedFlight === callsign ? null : callsign })),

  setFlightFilter: (flightFilter) => set({ flightFilter }),
  patchFlightFilter: (patch) =>
    set((s) => ({ flightFilter: { ...s.flightFilter, ...patch } })),
  resetFlightFilter: () => set({ flightFilter: EMPTY_FILTER }),

  selectAirport: (iata) =>
    set((s) => ({
      selectedAirport: s.selectedAirport === iata ? null : iata,
      // 反之亦然：开看板时关筛选
      filterOpen: iata && s.selectedAirport !== iata ? false : s.filterOpen,
      selectedFlight: null,
    })),


  setSearchOpen: (searchOpen) => set({ searchOpen }),

  toggleFilterPanel: () =>
    set((s) => ({
      filterOpen: !s.filterOpen,
      // 同一位置只能放一个浮层：开筛选时关掉机场看板
      selectedAirport: !s.filterOpen ? null : s.selectedAirport,
    })),

  setLiveSnapshot: (liveSnapshot) =>
    set((s) => {
      // 刷新后选中的航班可能已经落地/换了数据源，
      // 此时要清掉选中态，否则详情面板空白但高亮残留
      const stillExists =
        !s.selectedFlight ||
        (liveSnapshot?.flights.some((f) => f.callsign === s.selectedFlight) ?? false);
      return {
        liveSnapshot,
        selectedFlight: stillExists ? s.selectedFlight : null,
      };
    }),
  setLiveLoading: (liveLoading) => set({ liveLoading }),

  toggleAirports: () =>
    set((s) => {
      const next = !s.showAirports;
      return { showAirports: next };
    }),

  addRulerPoint: (p) =>
    set((s) => {
      // 最多留两个点：第三次点击重新开始
      const next = s.rulerPoints.length >= 2 ? [p] : [...s.rulerPoints, p];
      return { rulerPoints: next };
    }),

  clearRuler: () => set({ rulerPoints: [] }),

  toggleRulerMode: () => set((s) => ({ rulerMode: !s.rulerMode })),
  setFps: (fps) => set({ fps }),
  dismissIntro: () => set({ showIntro: false }),
  setSheet: (activeSheet) => set({ activeSheet }),
  swapEndpoints: () => {
    const { from, to } = get();
    set({ from: to, to: from, planning: true });
    queueMicrotask(() => get().recompute());
  },

}));

/** 便捷派生：层索引 */
export function levelPosOf(field: WindField, hPa: number): number {
  return pressureToLevelPos(field, hPa);
}
