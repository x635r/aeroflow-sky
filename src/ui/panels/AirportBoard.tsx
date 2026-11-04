import { useEffect, useMemo, useState } from 'react';
import { useStore, type Airport } from '../../state/store';
import { greatCircleDistance, initialBearing } from '../../core/geo';
import { flagEmoji } from '../../data/airlines';
import { CITY_ZH, AIRPORT_ZH } from '../../data/airportNamesZh';

/**
 * 机场看板
 * ---------------------------------------------------------------------------
 * 点地球上的机场（或从搜索里选）后展示这座机场的档案：
 *
 *   · 基本信息：IATA/ICAO、城市、国家、坐标、时区
 *   · 航线网络：从 routes.json 里找出与它有定期航班的城市对，
 *     按航班量排序，给出距离 / 方位角 / 竞争航司数
 *   · 实时：当前飞往/飞离这座机场的飞机（从 ADS-B 快照里按位置邻近筛）
 *
 * 数据边界必须说清楚：OpenFlights 的 routes 是**历史快照**（停更于 2014），
 * 只代表"曾有此航线"，不是今天的时刻表。UI 上明确标注，不能假装实时。
 */

type RouteRow = {
  other: Airport | undefined;
  iata: string;
  city: string;
  country: string;
  distanceKm: number;
  bearing: number;
  airlines: number;
  weekly: number;
  isDeparture: boolean;
};

/** routes.json 的原始行 */
type RawRoute = { a: string; b: string; airlines: number; n: number };

export function AirportBoard({ iata }: { iata: string }) {
  const airportsByIata = useStore((s) => s.airportsByIata);
  const selectAirport = useStore((s) => s.selectAirport);
  const setEndpoints = useStore((s) => s.setEndpoints);
  const from = useStore((s) => s.from);
  const to = useStore((s) => s.to);
  const snap = useStore((s) => s.liveSnapshot);

  const airport = airportsByIata.get(iata);

  const [routes, setRoutes] = useState<RawRoute[] | null>(null);
  const [loading, setLoading] = useState(false);

  // 航线数据只在首次打开时拉一次（37KB，全局共享）
  useEffect(() => {
    if (routes) return;
    let cancelled = false;
    setLoading(true);
    fetch('/data/routes.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { routes: RawRoute[] }) => {
        if (!cancelled) setRoutes(d.routes);
      })
      .catch(() => {
        if (!cancelled) setRoutes([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routes]);

  const rows = useMemo<RouteRow[]>(() => {
    if (!airport || !routes) return [];
    const out: RouteRow[] = [];
    for (const r of routes) {
      if (r.a !== iata && r.b !== iata) continue;
      const otherIata = r.a === iata ? r.b : r.a;
      const other = airportsByIata.get(otherIata);
      if (!other) continue;
      out.push({
        other,
        iata: otherIata,
        city: CITY_ZH[otherIata] ?? other.city,
        country: other.country,
        distanceKm: greatCircleDistance(airport, other) / 1000,
        bearing: initialBearing(airport, other),
        airlines: r.airlines,
        weekly: r.n,
        isDeparture: r.a === iata,
      });
    }
    // 按竞争航司数 → 航班量的复合权重排序（枢纽干线优先）
    out.sort((x, y) => y.airlines * 10 + y.weekly - (x.airlines * 10 + x.weekly));
    return out;
  }, [airport, routes, airportsByIata, iata]);

  /** 当前附近（±1.2°）的飞机，粗粒度地当作"本场航班" */
  const nearby = useMemo(() => {
    if (!airport || !snap) return [];
    return snap.flights
      .map((f) => ({
        f,
        d: greatCircleDistance({ lat: f.lat, lon: f.lon }, airport as unknown as { lat: number; lon: number }) / 1000,
      }))
      .filter((x) => x.d < 140)
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
  }, [airport, snap]);

  if (!airport) return null;

  const isFrom = from?.iata === iata;
  const isTo = to?.iata === iata;

  return (
    <div className="airport-board glass-strong">
      <div className="ab-head">
        <div className="ab-title">
          <span className="ab-flag">{flagEmoji('')}</span>
          <span className="ab-iata mono">{airport.iata}</span>
          <span className="ab-icao mono">{airport.icao}</span>
        </div>
        <button
          className="ab-close"
          onClick={() => selectAirport(null)}
          type="button"
          aria-label="关闭"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="ab-sub">
        <div className="ab-city">
          {CITY_ZH[airport.iata] ?? airport.city}
          {CITY_ZH[airport.iata] && (
            <span className="ab-en">{airport.city}</span>
          )}
        </div>
        <div className="ab-country">
          {AIRPORT_ZH[airport.iata] ? `${AIRPORT_ZH[airport.iata]} · ` : ''}
          {airport.country}
        </div>
      </div>

      <div className="ab-facts">
        <div>
          <dt>坐标</dt>
          <dd className="mono">
            {Math.abs(airport.lat).toFixed(2)}°{airport.lat >= 0 ? 'N' : 'S'}{' '}
            {Math.abs(airport.lon).toFixed(2)}°{airport.lon >= 0 ? 'E' : 'W'}
          </dd>
        </div>
        <div>
          <dt>时区</dt>
          <dd className="mono" style={{ fontSize: 9 }}>{airport.tz || '—'}</dd>
        </div>
        <div>
          <dt>航线数</dt>
          <dd className="mono">{rows.length || '—'}</dd>
        </div>
        <div>
          <dt>连接度</dt>
          <dd className="mono">{airport.degree ?? '—'}</dd>
        </div>
      </div>

      {/* 快速设为起降点 */}
      <div className="ab-actions">
        <button
          className="ab-action"
          data-on={isFrom}
          onClick={() => setEndpoints(airport, to)}
          type="button"
        >
          {isFrom ? '✓ 出发' : '设为出发'}
        </button>
        <button
          className="ab-action"
          data-on={isTo}
          onClick={() => setEndpoints(from, airport)}
          type="button"
        >
          {isTo ? '✓ 到达' : '设为到达'}
        </button>
      </div>

      {/* 本场飞机 */}
      {nearby.length > 0 && (
        <div className="ab-section">
          <div className="ab-label">
            <span className="caps">本场附近</span>
            <span className="ab-hint">±140 km</span>
          </div>
          {nearby.map(({ f, d }) => (
            <div key={f.callsign} className="ab-flight mono">
              <span className="ab-flight-cs">{f.callsign}</span>
              <span className="ab-flight-type">{f.type || '—'}</span>
              <span className="ab-flight-alt">FL{Math.round(f.altitudeM / 30.48)}</span>
              <span className="ab-flight-d">{d.toFixed(0)} km</span>
            </div>
          ))}
        </div>
      )}

      {/* 航线网络 */}
      {rows.length > 0 && (
        <div className="ab-section">
          <div className="ab-label">
            <span className="caps">航线网络 · Top {Math.min(12, rows.length)}</span>
            <span className="ab-hint">历史数据</span>
          </div>
          <div className="ab-routes">
            {rows.slice(0, 12).map((r) => (
              <button
                key={r.iata + (r.isDeparture ? 'd' : 'a')}
                className="ab-route"
                onClick={() => r.other && selectAirport(r.other.iata)}
                type="button"
                title={`${airport.iata} ↔ ${r.iata}`}
              >
                <span className="ab-route-code mono">{r.iata}</span>
                <span className="ab-route-city">{r.city}</span>
                <span className="ab-route-dist mono">{r.distanceKm.toFixed(0)}</span>
                <span className="ab-route-brg mono">{r.bearing.toFixed(0)}°</span>
                <span className="ab-route-air mono">{r.airlines}</span>
              </button>
            ))}
          </div>
          <div className="ab-note">
            OpenFlights 历史快照（停更于 2014），仅表示曾有此航线，非当前时刻表。
          </div>
        </div>
      )}

      {loading && <div className="ab-loading">载入航线数据…</div>}
    </div>
  );
}
