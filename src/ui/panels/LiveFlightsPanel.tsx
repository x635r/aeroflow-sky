import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { fetchLiveFlights, summarizeFlights, typeLabel, type LiveFlight } from '../../data/liveFlights';
import { timeToStepPos } from '../../data/windField';
import { msToKmh } from '../../core/atmos';
import { CAT_RAMP, sampleRamp, toCss } from '../../render/palette';
import { applyFilter, isFilterActive } from '../../data/flightFilter';
import { parseCallsign, flagEmoji } from '../../data/airlines';
import { CITY_ZH } from '../../data/airportNamesZh';

/**
 * 实时航班侧栏
 * ---------------------------------------------------------------------------
 * 每条航班都带「它此刻吃到多少顺风」——这是本产品的核心叙事，
 * 所以这里不展示无意义的经纬度，而是把风场匹配结果放在第一视觉层。
 *
 * 数据来源永远显式标注：真实 ADS-B 用绿色徽标，模拟用琥珀色徽标。
 * 绝不把模拟数据包装成「实时」，这是可信度的底线。
 */
/** 模块级常量：避免 snap 为 null 时每次渲染都新建数组（会让下游 memo 全部失效） */
const EMPTY_FLIGHTS: LiveFlight[] = [];

export function LiveFlightsPanel() {
  const field = useStore((s) => s.field);
  const timeMs = useStore((s) => s.timeMs);
  const pressureHpa = useStore((s) => s.pressureHpa);
  const snap = useStore((s) => s.liveSnapshot);
  const loading = useStore((s) => s.liveLoading);
  const setSnap = useStore((s) => s.setLiveSnapshot);
  const setLoading = useStore((s) => s.setLiveLoading);
  const selected = useStore((s) => s.selectedFlight);
  const selectFlight = useStore((s) => s.selectFlight);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tail' | 'head'>('all');
  const globalFilter = useStore((s) => s.flightFilter);
  const filterOpen = useStore((s) => s.filterOpen);
  const toggleFilterPanel = useStore((s) => s.toggleFilterPanel);
  const [reloadKey, setReloadKey] = useState(0);

  const stepPos = useMemo(() => (field ? timeToStepPos(field, timeMs) : 0), [field, timeMs]);

  // 用 ref 保存"最新一次请求的序号"，晚到的旧响应直接丢弃。
  // 否则快速切换高度层/连点刷新时，先发出的请求后返回，
  // 会把旧风场的结果覆盖到新的上面。
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!field) return;

    const myId = ++requestIdRef.current;
    const controller = new AbortController();
    setLoading(true);

    fetchLiveFlights(field, stepPos, pressureHpa, {
      endpoint: '/api/flights',
      limit: 18,
      signal: controller.signal,
    })
      .then((s) => {
        // 只有最新一次请求才允许写回
        if (myId === requestIdRef.current) setSnap(s);
      })
      .catch(() => {
        /* 取消或失败：保留上一次快照，不覆盖 */
      })
      .finally(() => {
        if (myId === requestIdRef.current) setLoading(false);
      });

    return () => {
      controller.abort();
    };
    // stepPos / pressureHpa 进依赖：拖动时间轴或切高度层后，
    // 列表里的「顺风 m/s」必须与地图上的风场保持同一口径
  }, [field, stepPos, pressureHpa, reloadKey, setSnap, setLoading]);

  // 每 2 分钟自动刷新（只依赖 field，避免与上面对 wind 变化的刷新重复触发）
  useEffect(() => {
    if (!field) return;
    const id = setInterval(() => setReloadKey((k) => k + 1), 120_000);
    return () => clearInterval(id);
  }, [field]);

  const load = () => setReloadKey((k) => k + 1);

  const allFlights = snap?.flights ?? EMPTY_FLIGHTS;
  // 全局筛选器（FilterPanel）优先于本地的顺/逆风快捷切换，
  // 两者叠加而不是互相覆盖——用户既筛了航司又想看顺风的很常见
  const flights = useMemo(() => applyFilter(allFlights, globalFilter), [allFlights, globalFilter]);
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
              className="flights-filter-filter"
              data-active={filterOpen || isFilterActive(globalFilter)}
              onClick={toggleFilterPanel}
              type="button"
              title="打开筛选"
              aria-label="打开航班筛选"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M3 6h18M7 12h10M11 18h2" strokeLinecap="round" />
              </svg>
            </button>
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

          {isFilterActive(globalFilter) && (
            <div className="flights-filtered-note">
              已筛选 · {shown.length} / {allFlights.length}
            </div>
          )}

          <div className="flights-list">
            {shown.length === 0 && (
              <div className="flights-empty">
                {loading ? '正在获取航班…' : '当前筛选下没有航班'}
              </div>
            )}
            {shown.slice(0, 12).map((f) => (
              <FlightRow
                key={`${f.callsign}-${f.lat.toFixed(2)}-${f.lon.toFixed(2)}`}
                f={f}
                active={selected === f.callsign}
                onSelect={() => selectFlight(f.callsign)}
              />
            ))}
          </div>

          <div className="flights-foot">
            {snap?.note ? (
              // 只有真的发生降级时才显示原因，不做无根据的猜测
              <span style={{ color: 'var(--hot)' }}>{snap.note}</span>
            ) : loading && !snap ? (
              <span>正在获取航班…</span>
            ) : (
              <span>
                {isReal ? '数据源：adsb.lol / OpenSky · 15s 边缘缓存' : '风场模拟数据'}
                {snap && ` · ${new Date(snap.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FlightRow({
  f,
  active,
  onSelect,
}: {
  f: LiveFlight;
  active: boolean;
  onSelect: () => void;
}) {
  const tailwind = f.windAlong;
  const tone = tailwind > 3 ? 'tail' : tailwind < -3 ? 'head' : 'neutral';
  const { airline } = parseCallsign(f.callsign);
  const catColor = toCss(sampleRamp(CAT_RAMP, Math.min(1, Math.max(0, (f.cat - 0.2) / 0.7))));

  return (
    <button
      className="flight-row"
      data-tone={tone}
      data-active={active}
      onClick={onSelect}
      type="button"
      aria-pressed={active}
    >
      <div className="flight-main">
        {airline && <span className="flight-flag">{flagEmoji(airline.cc)}</span>}
        <span className="flight-callsign mono">{f.callsign}</span>
        {airline && <span className="flight-airline">{airline.nameZh}</span>}
        <span className="flight-type">{typeLabel(f.type)}</span>
        <span className="flight-wind mono" data-tone={tone}>
          {tailwind >= 0 ? '+' : ''}
          {tailwind.toFixed(0)}
          <small>m/s</small>
        </span>
      </div>
      <div className="flight-sub">
        <span className="mono" title={`${CITY_ZH[f.origin] ?? f.origin} → ${CITY_ZH[f.destination] ?? f.destination}`}>
          {f.origin} <span style={{ color: 'var(--text-faint)' }}>→</span> {f.destination}
          {CITY_ZH[f.origin] && (
            <span className="flight-route-zh">
              {CITY_ZH[f.origin]}–{CITY_ZH[f.destination] ?? f.destination}
            </span>
          )}
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
    </button>
  );
}
