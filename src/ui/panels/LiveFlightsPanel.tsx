import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import { fetchLiveFlights, summarizeFlights, typeLabel, type LiveFlight, type LiveSnapshot } from '../../data/liveFlights';
import { timeToStepPos } from '../../data/windField';
import { msToKmh } from '../../core/atmos';
import { CAT_RAMP, sampleRamp, toCss } from '../../render/palette';

/**
 * 实时航班侧栏
 * ---------------------------------------------------------------------------
 * 每条航班都带「它此刻吃到多少顺风」——这是本产品的核心叙事，
 * 所以这里不展示无意义的经纬度，而是把风场匹配结果放在第一视觉层。
 *
 * 数据来源永远显式标注：真实 ADS-B 用绿色徽标，模拟用琥珀色徽标。
 * 绝不把模拟数据包装成「实时」，这是可信度的底线。
 */
export function LiveFlightsPanel() {
  const field = useStore((s) => s.field);
  const timeMs = useStore((s) => s.timeMs);
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tail' | 'head'>('all');

  const stepPos = useMemo(() => (field ? timeToStepPos(field, timeMs) : 0), [field, timeMs]);

  const load = () => {
    if (!field) return;
    setLoading(true);
    fetchLiveFlights(field, stepPos, { endpoint: '/api/flights', limit: 18 })
      .then((s) => setSnap(s))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // 每 2 分钟刷新一次，避免打爆上游速率；真实数据本身也是分钟级
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  const flights = snap?.flights ?? [];
  const stats = useMemo(() => summarizeFlights(flights), [flights]);

  const shown = useMemo(() => {
    if (filter === 'tail') return flights.filter((f) => f.windAlong > 3);
    if (filter === 'head') return flights.filter((f) => f.windAlong < -3);
    return flights;
  }, [flights, filter]);

  const isReal = snap?.source === 'opensky' || snap?.source === 'adsblol';

  return (
    <div className="flights-panel glass" data-collapsed={collapsed}>
      <div className="flights-head">
        <button
          className="flights-title"
          onClick={() => setCollapsed((c) => !c)}
          type="button"
          aria-expanded={!collapsed}
        >
          <span className={`status-dot`} data-tone={isReal ? undefined : 'warn'} />
          <span className="caps">高空航班</span>
          <span
            className="mono"
            style={{ fontSize: 9, color: isReal ? 'var(--safe)' : 'var(--hot)' }}
          >
            {snap ? (isReal ? 'ADS-B 实时' : '风场模拟') : '—'}
          </span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            style={{
              marginLeft: 'auto',
              transform: collapsed ? 'rotate(-90deg)' : 'none',
              transition: 'transform 0.2s',
              color: 'var(--text-faint)',
            }}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="flights-summary">
            <div className="flights-stat">
              <span className="flights-stat-val">
                {flights.length}
                <small>架</small>
              </span>
              <span className="flights-stat-label">巡航中</span>
            </div>
            <div className="flights-stat">
              <span
                className="flights-stat-val"
                style={{ color: stats.avgWindAlong >= 0 ? 'var(--safe)' : '#ff9f6b' }}
              >
                {stats.avgWindAlong >= 0 ? '+' : ''}
                {stats.avgWindAlong.toFixed(0)}
                <small>m/s</small>
              </span>
              <span className="flights-stat-label">平均顺风</span>
            </div>
            <div className="flights-stat">
              <span className="flights-stat-val" style={{ color: 'var(--hot)' }}>
                {(stats.headwindShare * 100).toFixed(0)}
                <small>%</small>
              </span>
              <span className="flights-stat-label">逆风比例</span>
            </div>
          </div>

          <div className="flights-filters">
            {(
              [
                ['all', '全部'],
                ['tail', '顺风'],
                ['head', '逆风'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className="flights-filter"
                data-active={filter === k}
                onClick={() => setFilter(k)}
                type="button"
              >
                {label}
              </button>
            ))}
            <button
              className="flights-refresh"
              onClick={load}
              disabled={loading}
              type="button"
              title="刷新"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" strokeLinecap="round" />
                <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="flights-list">
            {shown.length === 0 && (
              <div className="flights-empty">
                {loading ? '正在获取航班…' : '当前筛选下没有航班'}
              </div>
            )}
            {shown.slice(0, 12).map((f) => (
              <FlightRow key={`${f.callsign}-${f.lat.toFixed(2)}-${f.lon.toFixed(2)}`} f={f} />
            ))}
          </div>

          <div className="flights-foot">
            {snap?.note ? (
              <span style={{ color: 'var(--hot)' }}>{snap.note}</span>
            ) : (
              <span>
                {isReal ? '数据源：OpenSky / adsb.lol · 15s 边缘缓存' : '正在回退到模拟数据'}
                {snap && ` · ${new Date(snap.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FlightRow({ f }: { f: LiveFlight }) {
  const tailwind = f.windAlong;
  const tone = tailwind > 3 ? 'tail' : tailwind < -3 ? 'head' : 'neutral';
  const catColor = toCss(sampleRamp(CAT_RAMP, Math.min(1, Math.max(0, (f.cat - 0.2) / 0.7))));

  return (
    <div className="flight-row" data-tone={tone}>
      <div className="flight-main">
        <span className="flight-callsign mono">{f.callsign}</span>
        <span className="flight-type">{typeLabel(f.type)}</span>
        <span className="flight-wind mono" data-tone={tone}>
          {tailwind >= 0 ? '+' : ''}
          {tailwind.toFixed(0)}
          <small>m/s</small>
        </span>
      </div>
      <div className="flight-sub">
        <span className="mono">
          {f.origin} <span style={{ color: 'var(--text-faint)' }}>→</span> {f.destination}
        </span>
        <span className="mono" style={{ color: 'var(--text-dim)' }}>
          {msToKmh(f.groundSpeed).toFixed(0)} km/h
        </span>
        <span className="mono" style={{ color: catColor, fontSize: 9 }}>
          CAT {f.cat.toFixed(2)}
        </span>
        <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 9 }}>
          FL{Math.round(f.altitudeM / 30.48)}
        </span>
      </div>
      {/* 顺风/逆风条：以中点为 0，向右为顺风 */}
      <div className="flight-bar">
        <div className="flight-bar-mid" />
        <div
          className="flight-bar-fill"
          data-tone={tone}
          style={{
            width: `${Math.min(50, Math.abs(tailwind) * 1.1)}%`,
            left: tailwind >= 0 ? '50%' : `calc(50% - ${Math.min(50, Math.abs(tailwind) * 1.1)}%)`,
          }}
        />
      </div>
    </div>
  );
}
