import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { AirportPicker } from '../components/AirportPicker';
import { AIRCRAFT, aircraftById, pressureToAltitude, metersToFlightLevel } from '../../core/atmos';
import type { LayerState } from '../../state/store';

const LAYER_META: Array<{ key: keyof LayerState; label: string; color: string }> = [
  { key: 'aircraft', label: '飞机', color: '#7fd9f0' },
  { key: 'trails', label: '尾迹', color: '#5ee7c4' },
  { key: 'jet', label: '急流粒子', color: 'var(--jet)' },
  { key: 'gc', label: '大圆基准', color: '#8fa8bd' },
  { key: 'cat', label: '湍流区', color: 'var(--hot)' },
  { key: 'grid', label: '经纬网', color: '#3d7c9b' },
  { key: 'rhumb', label: '恒向线', color: '#5a6b7d' },
];

const PRESETS = [
  { from: 'JFK', to: 'LHR', label: '北大西洋' },
  { from: 'SFO', to: 'NRT', label: '北太平洋' },
  { from: 'PEK', to: 'JFK', label: '跨极' },
  { from: 'SIN', to: 'LHR', label: '欧亚' },
  { from: 'SYD', to: 'LAX', label: '南半球' },
];

const ALT_PRESETS = [
  { hPa: 200, fl: 387, name: 'FL387' },
  { hPa: 250, fl: 340, name: 'FL340' },
  { hPa: 300, fl: 300, name: 'FL300' },
];

export function ControlPanel() {
  const [openSection, setOpenSection] = useState<'perf' | 'layers' | null>('perf');
  const from = useStore((s) => s.from);
  const to = useStore((s) => s.to);
  const airports = useStore((s) => s.airports);
  const airportsByIata = useStore((s) => s.airportsByIata);
  const aircraftId = useStore((s) => s.aircraftId);
  const mach = useStore((s) => s.mach);
  const pressureHpa = useStore((s) => s.pressureHpa);
  const layers = useStore((s) => s.layers);
  const setEndpoints = useStore((s) => s.setEndpoints);
  const setAircraft = useStore((s) => s.setAircraft);
  const setMach = useStore((s) => s.setMach);
  const setPressure = useStore((s) => s.setPressure);
  const showAirports = useStore((s) => s.showAirports);
  const toggleAirports = useStore((s) => s.toggleAirports);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const swapEndpoints = useStore((s) => s.swapEndpoints);

  const profile = aircraftById(aircraftId);
  const altM = pressureToAltitude(pressureHpa);
  const fl = metersToFlightLevel(altM);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    const a = airportsByIata.get(p.from);
    const b = airportsByIata.get(p.to);
    if (a && b) setEndpoints(a, b);
  };

  const availablePresets = useMemo(
    () => PRESETS.filter((p) => airportsByIata.has(p.from) && airportsByIata.has(p.to)),
    [airportsByIata],
  );

  return (
    <div className="panel-left glass">
      <div className="panel-head">
        <span className="caps">航线沙盒</span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--text-faint)' }}>
          GREAT CIRCLE SANDBOX
        </span>
      </div>

      <div className="panel-body">
        <div className="panel-section">
          <div className="airport-picker">
            <AirportPicker
              role="from"
              value={from}
              airports={airports}
              onChange={(a) => setEndpoints(a, to)}
            />
            <button className="swap-btn" onClick={swapEndpoints} title="交换起降" type="button" aria-label="交换起降机场">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" strokeLinecap="round" />
              </svg>
            </button>
            <AirportPicker
              role="to"
              value={to}
              airports={airports}
              onChange={(a) => setEndpoints(from, a)}
            />
          </div>

          {availablePresets.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 9 }}>
              {availablePresets.map((p) => {
                const active = from?.iata === p.from && to?.iata === p.to;
                return (
                  <button
                    key={p.label}
                    className="chip"
                    data-active={active}
                    onClick={() => applyPreset(p)}
                    type="button"
                    style={{ fontSize: 10, padding: '3px 8px' }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel-section">
          <button
            className="section-label section-toggle"
            onClick={() => setOpenSection((s) => (s === 'perf' ? null : 'perf'))}
            type="button"
            aria-expanded={openSection === 'perf'}
          >
            <span className="caps">机型与性能 · {profile.shortName}</span>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
              style={{ transform: openSection === 'perf' ? 'none' : 'rotate(-90deg)', transition: 'transform .18s', flexShrink: 0 }}>
              <path d="M6 9l6 6 6-6" strokeLinecap="round" />
            </svg>
          </button>

          <div style={{ display: openSection === 'perf' ? 'flex' : 'none', gap: 4, flexWrap: 'wrap', marginBottom: 11 }}>
            {AIRCRAFT.map((a) => (
              <button
                key={a.id}
                className="chip"
                data-active={a.id === aircraftId}
                onClick={() => setAircraft(a.id)}
                title={a.name}
                type="button"
                style={{ fontSize: 10, padding: '3px 8px' }}
              >
                {a.shortName}
              </button>
            ))}
          </div>

          <div style={{ display: openSection === 'perf' ? 'block' : 'none' }}>
          <div className="slider-row">
            <div className="slider-head">
              <span className="slider-name">巡航马赫</span>
              <span className="slider-value">
                M {mach.toFixed(3)}
                <small>
                  {(mach * 340).toFixed(0)} m/s 量级
                </small>
              </span>
            </div>
            <input
              type="range"
              min={0.72}
              max={0.9}
              step={0.005}
              value={mach}
              onChange={(e) => setMach(Number(e.target.value))}
              aria-label="巡航马赫数"
            />
          </div>

          <div className="slider-row">
            <div className="slider-head">
              <span className="slider-name">巡航高度层</span>
              <span className="slider-value">
                FL{fl}
                <small>{(altM / 1000).toFixed(1)} km</small>
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={1}
              value={ALT_PRESETS.findIndex((a) => a.hPa === pressureHpa)}
              onChange={(e) => {
                const idx = Number(e.target.value);
                setPressure(ALT_PRESETS[Math.max(0, Math.min(2, idx))].hPa);
              }}
              aria-label="巡航高度层"
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 8.5,
                color: 'var(--text-faint)',
                fontFamily: 'var(--font-mono)',
                marginTop: 3,
              }}
            >
              {ALT_PRESETS.map((a) => (
                <button
                  key={a.hPa}
                  onClick={() => setPressure(a.hPa)}
                  type="button"
                  style={{
                    color: a.hPa === pressureHpa ? 'var(--jet)' : 'inherit',
                    fontWeight: a.hPa === pressureHpa ? 600 : 400,
                  }}
                >
                  {a.name}
                </button>
              ))}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '8px 0 0',
              fontSize: 9.5,
              color: 'var(--text-faint)',
              borderTop: '1px solid rgba(120,190,230,0.08)',
              marginTop: 4,
            }}
          >
            <span>{profile.name}</span>
            <span style={{ marginLeft: 'auto' }}>
              {profile.seats} 座 · {(profile.rangeKm / 1000).toFixed(1)} 千 km
            </span>
          </div>
          </div>
        </div>

        <div className="panel-section">
          <button
            className="section-label section-toggle"
            onClick={() => setOpenSection((s) => (s === 'layers' ? null : 'layers'))}
            type="button"
            aria-expanded={openSection === 'layers'}
          >
            <span className="caps">图层 · {LAYER_META.filter((l) => layers[l.key]).length}/{LAYER_META.length} 开启</span>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
              style={{ transform: openSection === 'layers' ? 'none' : 'rotate(-90deg)', transition: 'transform .18s', flexShrink: 0 }}>
              <path d="M6 9l6 6 6-6" strokeLinecap="round" />
            </svg>
          </button>
          <div className="layer-grid" style={{ display: openSection === 'layers' ? 'grid' : 'none' }}>
            <button
              className="layer-toggle"
              data-on={showAirports}
              onClick={toggleAirports}
              type="button"
              aria-pressed={showAirports}
            >
              <span
                className="layer-dot"
                style={{
                  background: showAirports ? '#ffd166' : 'transparent',
                  border: '1px solid #ffd166',
                }}
              />
              机场网络
            </button>
            {LAYER_META.map((l) => (
              <button
                key={l.key}
                className="layer-toggle"
                data-on={layers[l.key]}
                onClick={() => toggleLayer(l.key)}
                type="button"
                aria-pressed={layers[l.key]}
              >
                <span className="layer-dot" style={{ background: layers[l.key] ? l.color : 'transparent', border: `1px solid ${l.color}` }} />
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
