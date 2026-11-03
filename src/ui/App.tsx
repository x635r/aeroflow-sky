import { forwardRef, useEffect, useRef, useState } from 'react';
import { GlobeScene } from '../render/GlobeScene';
import { useStore } from '../state/store';
import { loadWindField } from '../data/windField';
import type { LandPolygon } from '../render/landTexture';
import { ControlPanel } from './panels/ControlPanel';
import { ResultPanel } from './panels/ResultPanel';
import { TimeBar } from './panels/TimeBar';
import { WindLegend } from './panels/WindLegend';
import { LiveFlightsPanel } from './panels/LiveFlightsPanel';
import { TurbulencePanel } from './panels/TurbulencePanel';
import { FlightDetailPanel } from './panels/FlightDetailPanel';
import { RulerPanel } from './panels/RulerPanel';
import { RouteProfile } from './panels/RouteProfile';
import { LoadingScreen } from './components/LoadingScreen';
import { levelPosOf } from '../state/store';
import { timeToStepPos } from '../data/windField';

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [bootDone, setBootDone] = useState(false);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [profileCursor, setProfileCursor] = useState<number | null>(null);

  const loading = useStore((s) => s.loading);
  const setLoad = useStore((s) => s.setLoad);
  const initData = useStore((s) => s.initData);
  const field = useStore((s) => s.field);
  const result = useStore((s) => s.result);
  const from = useStore((s) => s.from);
  const to = useStore((s) => s.to);
  const pressureHpa = useStore((s) => s.pressureHpa);
  const timeMs = useStore((s) => s.timeMs);
  const layers = useStore((s) => s.layers);
  const setHover = useStore((s) => s.setHover);
  const setFps = useStore((s) => s.setFps);
  const fps = useStore((s) => s.fps);
  const hover = useStore((s) => s.hover);
  const showAirports = useStore((s) => s.showAirports);
  const selectedFlight = useStore((s) => s.selectedFlight);
  const rulerPoints = useStore((s) => s.rulerPoints);
  const showIntro = useStore((s) => s.showIntro);
  const dismissIntro = useStore((s) => s.dismissIntro);
  const recompute = useStore((s) => s.recompute);

  // ---------- 启动 ----------
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const scene = new GlobeScene(host, {
      onHover: (lat, lon) => setHover({ lat, lon }),
      onPickAirport: (ap) => {
        const s = useStore.getState();
        // 测距模式优先：围着枢纽点测距时，点到的全是机场，
        // 若这里不判断 rulerMode，测距就永远拿不到点
        if (s.rulerMode) {
          s.addRulerPoint({ lat: ap.lat, lon: ap.lon, label: ap.iata });
          return;
        }
        // 点机场：按当前起降状态填入起点或终点
        if (!s.from || (s.from && s.to)) s.setEndpoints(ap, s.to === ap ? null : s.to);
        else s.setEndpoints(s.from, ap);
      },
      onPick: (lat, lon) => {
        const st = useStore.getState();
        // 测距模式：把点击点交给测距工具
        if (st.rulerMode) {
          st.addRulerPoint({ lat, lon });
          return;
        }
        // 点击地球：移动最近的机场作为到达点
        const { airports: list } = st;
        if (!list.length) return;
        let best = list[0];
        let bestD = Infinity;
        for (const a of list) {
          const dLat = a.lat - lat;
          let dLon = a.lon - lon;
          while (dLon > 180) dLon -= 360;
          while (dLon < -180) dLon += 360;
          const d = dLat * dLat + dLon * dLon * Math.cos((lat * Math.PI) / 180) ** 2;
          if (d < bestD) {
            bestD = d;
            best = a;
          }
        }
        const s = useStore.getState();
        if (!s.from) s.setEndpoints(best, s.to);
        else if (!s.to) s.setEndpoints(s.from, best);
        else s.setEndpoints(s.from, best);
      },
      onStats: (st) => setFps(st.fps),
      onReady: () => setSceneReady(true),
    });
    sceneRef.current = scene;

    (async () => {
      try {
        setLoad({ stage: 'static', progress: 0.02 });

        // 并行：风场二进制 + 静态地理数据
        const windPromise = loadWindField('/data/', (loaded, total) => {
          setLoadProgress(Math.min(0.92, loaded / Math.max(total, 1)) * 0.82);
          setLoad({ stage: 'wind', progress: Math.min(1, loaded / Math.max(total, 1)) });
        });

        const [landRes, apRes, wind] = await Promise.all([
          fetch('/data/land-50m.json'),
          fetch('/data/airports.json'),
          windPromise,
        ]);
        if (!landRes.ok) throw new Error(`陆地数据 HTTP ${landRes.status}`);
        if (!apRes.ok) throw new Error(`机场数据 HTTP ${apRes.status}`);

        const land = (await landRes.json()) as { polygons: LandPolygon[] };
        const ap = (await apRes.json()) as { airports: ReturnType<typeof useStore.getState>['airports'] };

        // StrictMode 下会「挂载 → 卸载 → 再挂载」：第一次 cleanup 已 dispose，
        // 但第一次的异步 boot 仍在跑。必须在每个 await 后重新检查，
        // 否则会把整套 GPU 资源（jet 拖尾 ≈134MB）建到已销毁的 renderer 上。
        if (cancelled) return;

        setLoad({ stage: 'static', progress: 0.9 });
        await scene.loadLand(land.polygons);
        if (cancelled) return;

        await scene.attachWind(wind);
        if (cancelled) return;

        setLoadProgress(1);
        const manifest = {
          version: 1,
          file: '',
          bytes: 0,
          header: wind.header,
        };
        initData(wind, manifest as never, ap.airports);
        scene.attachAirports(ap.airports);

        // 默认航线：如果有 JFK/LHR 就用它们
        const jfk = ap.airports.find((a) => a.iata === 'JFK');
        const lhr = ap.airports.find((a) => a.iata === 'LHR');
        if (jfk && lhr) {
          useStore.getState().setEndpoints(jfk, lhr);
        }
        setBootDone(true);
      } catch (e) {
        if (cancelled) return;
        console.error('[boot] 失败', e);
        setLoad({ stage: 'error', message: (e as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      scene.dispose();
      sceneRef.current = null;
    };
  }, [setLoad, initData, setHover, setFps]);

  // ---------- 风场帧更新 ----------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !field) return;
    const levelPos = levelPosOf(field, pressureHpa);
    const stepPos = timeToStepPos(field, timeMs);
    scene.setWindFrame(levelPos, stepPos);
    // 换层时重算航线（风变了，最优航线也变）
    recompute();
  }, [field, pressureHpa, timeMs, recompute]);

  // ---------- 航线渲染 ----------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !sceneReady) return;
    if (!result) {
      scene.clearRoutes();
      return;
    }
    scene.showRoutes(result.optimal, result.gc, layers.rhumb ? result.rhumb : undefined);
  }, [result, sceneReady, layers.rhumb]);

  // ---------- 选中航班：高亮其起降机场 ----------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!selectedFlight) {
      scene.highlightAirport(null);
      return;
    }
    const snap = useStore.getState().liveSnapshot;
    const f = snap?.flights.find((x) => x.callsign === selectedFlight);
    scene.highlightAirport(f?.origin && f.origin !== '—' ? f.origin : null);
  }, [selectedFlight]);

  // ---------- 图层开关 ----------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setLayerVisibility('jet', layers.jet);
    scene.setLayerVisibility('gc', layers.gc);
    scene.setLayerVisibility('rhumb', layers.rhumb);
    scene.setLayerVisibility('cat', layers.cat);
    scene.setLayerVisibility('grid', layers.grid);
    scene.setLayerVisibility('airports', showAirports);
    scene.setJetParams({ showCat: layers.cat });
  }, [layers, showAirports]);

  // ---------- 测距线 ----------
  useEffect(() => {
    sceneRef.current?.setRulerPoints(rulerPoints);
  }, [rulerPoints]);

  // ---------- 指针跟随 ----------
  // 用 ref 直接改 transform，不走 React state：指针每次移动都 setState
  // 会让整棵 UI 树（7 个面板）每帧重渲染。
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = cursorRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
      el.style.opacity = '1';
    };
    const onLeave = () => {
      const el = cursorRef.current;
      if (el) el.style.opacity = '0';
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // ---------- 剖面游标：跟随相机前进进度 ----------
  useEffect(() => {
    if (!result) {
      setProfileCursor(null);
      return;
    }
    // 用「离相机最近的航路点」作为游标，让剖面与地球视角联动。
    let raf = 0;
    let lastSet = -1;
    let lastAt = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const scene = sceneRef.current;
      if (!scene || !result.optimal.points.length) return;

      // 12Hz 足以表达「相机在航路哪一段」。每帧扫 100+ 点纯属浪费，
      // 而且 cursorIndex 一变 RouteProfile 就要重算 36 段 bandData 与两条 path。
      const now = performance.now();
      if (now - lastAt < 80) return;
      lastAt = now;

      const cam = scene.getCameraLatLon();
      const pts = result.optimal.points;
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i += 1) {
        const dLat = pts[i].lat - cam.lat;
        let dLon = pts[i].lon - cam.lon;
        while (dLon > 180) dLon -= 360;
        while (dLon < -180) dLon += 360;
        const d = dLat * dLat + dLon * dLon * Math.cos((pts[i].lat * Math.PI) / 180) ** 2;
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      // 索引没变就不 setState
      if (bestI !== lastSet) {
        lastSet = bestI;
        setProfileCursor(bestI);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [result]);



  return (
    <div className="app">
      <div className="globe-host" ref={hostRef} />

      <div className="ui-layer">
        {/* 顶部品牌 */}
        <div className="topbar">
          <div className="brand">
            <div className="brand-mark">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="9.2" stroke="rgba(53,208,245,0.55)" strokeWidth="1.1" />
                <ellipse cx="12" cy="12" rx="4.2" ry="9.2" stroke="rgba(53,208,245,0.32)" strokeWidth="0.9" />
                <path d="M2.8 12h18.4" stroke="rgba(53,208,245,0.32)" strokeWidth="0.9" />
                <path
                  d="M5.5 16.4c3.4-2.2 6.6-2.9 9-2.1 2 .7 2.6 2 2.2 3.2"
                  stroke="#7ff0d2"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx="8.6" cy="8.4" r="1.5" fill="#ffc86b" />
              </svg>
            </div>
            <div className="brand-text">
              <h1>AeroFlow Sky</h1>
              <p>全球高空急流 · 跨洋航线借风推演</p>
            </div>
          </div>

          <div className="topbar-right">
            <span className="status-pill">
              <span className="status-dot" data-tone={loading.stage === 'ready' ? undefined : 'busy'} />
              {loading.stage === 'ready'
                ? `GFS ${field?.header.cycle?.slice(0, 10) ?? ''}`
                : '载入中'}
            </span>
            <span className="status-pill">
              <span className="caps" style={{ fontSize: 8.5 }}>
                FL
              </span>
              <span className="mono" style={{ fontSize: 10.5 }}>
                {pressureHpa === 200 ? 387 : pressureHpa === 250 ? 340 : 300}
              </span>
            </span>
            <span className="status-pill mono" style={{ fontSize: 10 }}>
              {fps} FPS
            </span>
          </div>
        </div>

        <ControlPanel />
        <ResultPanel
          result={result}
          fromCode={from?.iata ?? '—'}
          toCode={to?.iata ?? '—'}
        />
        <WindLegend />
        <LiveFlightsPanel />
        <TurbulencePanel />
        <RulerPanel />
        {selectedFlight && <FlightDetailPanel />}
        <TimeBar />

        {/* 剖面图挂到右侧面板底部区域 */}
        <ProfileDock cursorIndex={profileCursor} />

        {hover && <CursorCross ref={cursorRef} />}

        {showIntro && <IntroOverlay onDismiss={dismissIntro} />}
      </div>

      <LoadingScreen
        stage={loading}
        progress={loading.stage === 'ready' ? 1 : loadProgress}
        done={bootDone}
      />
    </div>
  );
}

/** 剖面图：贴在右侧面板下方 */
function ProfileDock({ cursorIndex }: { cursorIndex: number | null }) {
  const result = useStore((s) => s.result);
  if (!result) return null;
  return (
    <div
      className="glass"
      style={{
        position: 'absolute',
        right: 22,
        bottom: 22,
        width: 344,
        overflow: 'hidden',
      }}
    >
      <RouteProfile points={result.optimal.points} cursorIndex={cursorIndex} />
    </div>
  );
}

const CursorCross = forwardRef<HTMLDivElement>(function CursorCross(_props, ref) {
  // 位置由父组件的指针监听直接写 transform，这里既不收 props 也不触发渲染
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: 18,
        height: 18,
        marginLeft: -9,
        marginTop: -9,
        pointerEvents: 'none',
        zIndex: 55,
        opacity: 0,
        transition: 'opacity 0.15s',
        willChange: 'transform',
      }}
      aria-hidden
    >
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r="6.5" fill="none" stroke="rgba(53,208,245,0.7)" strokeWidth="0.9" />
        <circle cx="9" cy="9" r="1.5" fill="rgba(200,240,255,0.9)" />
      </svg>
    </div>
  );
});

function IntroOverlay({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(circle at 50% 50%, rgba(3,6,12,0.35), rgba(3,6,12,0.82))',
        backdropFilter: 'blur(3px)',
        zIndex: 70,
        padding: 24,
      }}
      onClick={onDismiss}
      role="dialog"
      aria-label="产品介绍"
    >
      <div
        className="glass-strong"
        style={{
          maxWidth: 470,
          padding: '28px 30px 24px',
          animation: 'rise 0.5s ease',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="caps" style={{ marginBottom: 10 }}>
          数据驱动的航空气象推演
        </div>
        <h2
          style={{
            margin: '0 0 12px',
            fontSize: 21,
            fontWeight: 650,
            letterSpacing: '-0.02em',
            lineHeight: 1.35,
            background: 'linear-gradient(100deg,#fff,#a8e3f5 55%,#7ff0d2)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          万米高空的同一架飞机，
          <br />
          为什么东西向能差一小时？
        </h2>
        <p style={{ margin: '0 0 14px', color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.85 }}>
          本工具读取 <b style={{ color: 'var(--text)' }}>NOAA GFS</b> 的真实高空风场，
          在 GPU 上把 FL300–FL390 的急流画成流线。选一对机场，它会同时解出
          <b style={{ color: 'var(--jet-warm)' }}> 理论最短大圆</b> 与
          <b style={{ color: 'var(--hot)' }}> 借风最快航线</b>，
          并给出顺风、逆风两个方向的地速与时间差。
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
            marginBottom: 18,
          }}
        >
          {[
            ['GFS 0.25°', '官方 GRIB2'],
            ['AFLW float16', 'GPU 直读'],
            ['Ellrod TI1', '湍流指数'],
          ].map(([a, b]) => (
            <div
              key={a}
              style={{
                padding: '9px 10px',
                borderRadius: 9,
                background: 'rgba(53,208,245,0.06)',
                border: '1px solid rgba(53,208,245,0.16)',
              }}
            >
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--jet)', fontWeight: 600 }}>
                {a}
              </div>
              <div style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 2 }}>{b}</div>
            </div>
          ))}
        </div>
        <button
          onClick={onDismiss}
          type="button"
          style={{
            width: '100%',
            padding: '11px 0',
            borderRadius: 10,
            background: 'linear-gradient(100deg, rgba(53,208,245,0.22), rgba(127,240,210,0.18))',
            border: '1px solid rgba(53,208,245,0.4)',
            color: '#cdf3ff',
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: '0.02em',
            transition: 'all 0.18s',
          }}
        >
          开始推演
        </button>
        <div style={{ textAlign: 'center', marginTop: 10, fontSize: 9, color: 'var(--text-faint)' }}>
          气象：NOAA NCEP GFS · 机场与航路：OpenFlights · 海岸线：Natural Earth
        </div>
      </div>
    </div>
  );
}
