import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { msToKmh, formatHm } from '../../core/atmos';
import { typeLabel } from '../../data/liveFlights';
import { CAT_RAMP, WIND_RAMP, sampleRamp, toCss } from '../../render/palette';
import { timeToStepPos, pressureToLevelPos, sampleWind } from '../../data/windField';
import { solveWindTriangle, machToTas, aircraftById } from '../../core/atmos';

/**
 * 选中航班详情面板
 * ---------------------------------------------------------------------------
 * 对标 FR24 的航班卡片：显示谁、在哪、多快、多高、吃什么风。
 *
 * 关键设计：这里显示的「顺风分量」不是把 ADS-B 报的地速和标称真空速相减
 * 得到的粗糙估值，而是用**当前风场在该点的真实矢量**重新解一次风三角。
 * 这样列表里的数字与地图上的风场是同一份数据，可以互相对照。
 */
export function FlightDetailPanel() {
  const snap = useStore((s) => s.liveSnapshot);
  const callsign = useStore((s) => s.selectedFlight);
  const selectFlight = useStore((s) => s.selectFlight);
  const field = useStore((s) => s.field);
  const timeMs = useStore((s) => s.timeMs);
  const setEndpoints = useStore((s) => s.setEndpoints);
  const airportsByIata = useStore((s) => s.airportsByIata);

  const flight = useMemo(() => {
    if (!snap || !callsign) return null;
    return snap.flights.find((f) => f.callsign === callsign) ?? null;
  }, [snap, callsign]);

  // 用当前风场重新解一次该点的风三角，给出与地图一致的口径
  const derived = useMemo(() => {
    if (!flight || !field) return null;
    const levelPos = pressureToLevelPos(field, 250);
    const stepPos = timeToStepPos(field, timeMs);
    const w = sampleWind(field, flight.lat, flight.lon, { levelPos, stepPos });
    const profile = aircraftById(
      /^(B77|A35|B78)/.test(flight.type) ? 'b77w' : /^(A32|B73)/.test(flight.type) ? 'b738' : 'b77w',
    );
    const tas = machToTas(profile.cruiseMach, w.tempK);
    const tri = solveWindTriangle(flight.track, tas, w);
    return { wind: w, tas, tri, profile };
  }, [flight, field, timeMs]);

  if (!flight) return null;

  const speedKmh = msToKmh(flight.groundSpeed);
  const windKmh = derived ? msToKmh(derived.wind.speed) : 0;
  const along = derived ? -derived.tri.headwindComponent : flight.windAlong;
  const isTail = along > 0;
  const catColor = toCss(sampleRamp(CAT_RAMP, Math.min(1, Math.max(0, (flight.cat - 0.2) / 0.65))));
  const speedColor = toCss(sampleRamp(WIND_RAMP, Math.min(1, (derived?.wind.speed ?? 0) / 110)));

  const originAirport = flight.origin !== '—' ? airportsByIata.get(flight.origin) : undefined;
  const destAirport = flight.destination !== '—' ? airportsByIata.get(flight.destination) : undefined;

  return (
    <div className="flight-detail glass-strong">
      <div className="fd-head">
        <div className="fd-ident">
          <span className="fd-callsign mono">{flight.callsign}</span>
          <span className="fd-type">{flight.type || '—'} · {typeLabel(flight.type)}</span>
        </div>
        <button className="fd-close" onClick={() => selectFlight(null)} type="button" aria-label="关闭">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* 航线：起点 → 终点 */}
      <div className="fd-route">
        <div className="fd-endpoint">
          <span className="mono fd-code">{flight.origin}</span>
          <span className="fd-city">{originAirport?.city ?? '未知'}</span>
        </div>
        <div className="fd-route-mid">
          <svg width="46" height="14" viewBox="0 0 46 14" aria-hidden>
            <line x1="2" y1="7" x2="40" y2="7" stroke="rgba(120,190,230,0.35)" strokeWidth="1" strokeDasharray="3 3" />
            <path d="M36 3l6 4-6 4" fill="none" stroke="rgba(120,190,230,0.6)" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
        <div className="fd-endpoint" style={{ textAlign: 'right' }}>
          <span className="mono fd-code">{flight.destination}</span>
          <span className="fd-city">{destAirport?.city ?? '未知'}</span>
        </div>
      </div>

      {/* 核心遥测 */}
      <div className="fd-telemetry">
        <div className="fd-tel">
          <span className="fd-tel-val mono">{speedKmh.toFixed(0)}</span>
          <span className="fd-tel-unit">km/h 地速</span>
        </div>
        <div className="fd-tel">
          <span className="fd-tel-val mono">FL{Math.round(flight.altitudeM / 30.48)}</span>
          <span className="fd-tel-unit">高度层</span>
        </div>
        <div className="fd-tel">
          <span className="fd-tel-val mono">{flight.track.toFixed(0)}°</span>
          <span className="fd-tel-unit">航迹</span>
        </div>
      </div>

      {/* 风场匹配：这是本产品的核心叙事 */}
      <div className="fd-wind">
        <div className="fd-wind-head">
          <span className="caps" style={{ fontSize: 9 }}>风场匹配</span>
          <span
            className="fd-wind-verdict"
            data-tone={isTail ? 'tail' : along < -3 ? 'head' : 'neutral'}
          >
            {isTail ? '顺风借力' : along < -3 ? '逆风搏击' : '侧风'}
            {' '}
            <b>
              {along >= 0 ? '+' : ''}
              {along.toFixed(0)}
            </b>
            m/s
          </span>
        </div>

        <div className="fd-viz">
          {/* 真空速 vs 地速的矢量条 */}
          <div className="fd-bar-row">
            <span className="fd-bar-label">真空速</span>
            <div className="fd-bar">
              <div
                className="fd-bar-fill"
                style={{
                  width: `${Math.min(100, ((derived?.tas ?? 0) / 350) * 100)}%`,
                  background: 'linear-gradient(90deg, rgba(120,190,230,0.5), rgba(160,215,245,0.85))',
                }}
              />
            </div>
            <span className="fd-bar-val mono">{derived ? msToKmh(derived.tas).toFixed(0) : '—'}</span>
          </div>
          <div className="fd-bar-row">
            <span className="fd-bar-label">地速</span>
            <div className="fd-bar">
              <div
                className="fd-bar-fill"
                style={{
                  width: `${Math.min(100, (speedKmh / 350) * 100)}%`,
                  background: isTail
                    ? 'linear-gradient(90deg, rgba(94,231,196,0.55), var(--safe))'
                    : 'linear-gradient(90deg, rgba(255,159,107,0.55), #ff9f6b)',
                }}
              />
            </div>
            <span className="fd-bar-val mono" style={{ color: isTail ? 'var(--safe)' : '#ff9f6b' }}>
              {speedKmh.toFixed(0)}
            </span>
          </div>
        </div>

        <div className="fd-grid">
          <div><dt>风速</dt><dd style={{ color: speedColor }}>{windKmh.toFixed(0)} km/h</dd></div>
          <div><dt>风向</dt><dd>{derived?.wind.direction.toFixed(0) ?? '—'}°</dd></div>
          <div><dt>静温</dt><dd>{derived ? (derived.wind.tempK - 273.15).toFixed(0) : '—'}°C</dd></div>
          <div><dt>湍流</dt><dd style={{ color: catColor }}>{flight.cat.toFixed(2)}</dd></div>
        </div>
      </div>

      {/* 操作 */}
      <div className="fd-actions">
        <button
          className="fd-action"
          type="button"
          disabled={!originAirport || !destAirport}
          onClick={() => {
            if (originAirport && destAirport) setEndpoints(originAirport, destAirport);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" />
            <path d="M8 8l8 8" strokeLinecap="round" />
          </svg>
          用此航路推演
        </button>
        {flight.real ? (
          <span className="fd-src" data-real="true">ADS-B 实时</span>
        ) : (
          <span className="fd-src" data-real="false">风场模拟</span>
        )}
      </div>

      <div className="fd-pos mono">
        {Math.abs(flight.lat).toFixed(2)}°{flight.lat >= 0 ? 'N' : 'S'}{' '}
        {Math.abs(flight.lon).toFixed(2)}°{flight.lon >= 0 ? 'E' : 'W'}
        {snap && (
          <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>
            {new Date(snap.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        )}
      </div>
    </div>
  );
}

export const _fdh = { formatHm };
