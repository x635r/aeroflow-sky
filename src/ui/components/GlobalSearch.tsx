import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { parseCallsign, flagEmoji, AIRLINES } from '../../data/airlines';
import type { Airport } from '../../state/store';
import { CITY_ZH, AIRPORT_ZH } from '../../data/airportNamesZh';
import type { LiveFlight } from '../../data/liveFlights';

/**
 * 全局搜索
 * ---------------------------------------------------------------------------
 * FR24 里最高频的入口：一个框同时搜航班、机场、航司。
 *
 * 设计要点：
 *   · **结果分组而不是混排**：用户搜 "JFK" 时想知道是机场，
 *     搜 "BAW" 时想知道是航司，混在一起会分不清。
 *   · **键盘优先**：↑↓ 选择、Enter 确认、Esc 关闭、`/` 唤起。
 *     真正用它的人不会去点鼠标。
 *   · **零网络**：航班从当前快照里搜，机场/航司来自已加载的静态表，
 *     输入即出结果，没有请求延迟。
 */

type Hit =
  | { kind: 'flight'; flight: LiveFlight; score: number }
  | { kind: 'airport'; airport: Airport; score: number }
  | { kind: 'airline'; icao: string; nameZh: string; name: string; cc: string; count: number; score: number };

/** 打分：完全匹配 > 前缀匹配 > 包含 */
function score(text: string, q: string): number {
  if (!text || !q) return 0;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (t === s) return 1000;
  if (t.startsWith(s)) return 600;
  // 词首匹配（如 "air china" 里的 "china"）
  if (t.split(/[\s\-_/]+/).some((w) => w.startsWith(s))) return 400;
  if (t.includes(s)) return 200;
  return 0;
}

export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const airports = useStore((s) => s.airports);
  const snap = useStore((s) => s.liveSnapshot);
  const selectAirport = useStore((s) => s.selectAirport);
  const selectFlight = useStore((s) => s.selectFlight);
  const setEndpoints = useStore((s) => s.setEndpoints);
  const from = useStore((s) => s.from);
  const to = useStore((s) => s.to);

  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 航司聚合：从当前快照统计出"在场航司"，搜起来才有意义
  const airlineCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of snap?.flights ?? []) {
      const { airline } = parseCallsign(f.callsign);
      if (airline) m.set(airline.icao, (m.get(airline.icao) ?? 0) + 1);
    }
    return m;
  }, [snap]);

  const hits = useMemo<Hit[]>(() => {
    const query = q.trim();
    if (!query) return [];

    const out: Hit[] = [];

    // ---- 航班 ----
    for (const f of snap?.flights ?? []) {
      const { airline } = parseCallsign(f.callsign);
      const origZh = CITY_ZH[f.origin] ?? '';
      const destZh = CITY_ZH[f.destination] ?? '';
      const s = Math.max(
        score(f.callsign, query),
        score(f.type, query),
        score(f.origin, query),
        score(f.destination, query),
        score(origZh, query) * 0.95,
        score(destZh, query) * 0.95,
        airline ? score(airline.nameZh, query) * 0.9 : 0,
      );
      if (s > 0) out.push({ kind: 'flight', flight: f, score: s + 100 });
    }

    // ---- 机场 ----
    // 中文城市名/机场名必须参与匹配：数据源只有英文，
    // 中文用户输入"东京""浦东"否则什么都搜不到。
    for (const a of airports) {
      const cityZh = CITY_ZH[a.iata] ?? '';
      const nameZh = AIRPORT_ZH[a.iata] ?? '';
      const s = Math.max(
        score(a.iata, query) * 1.15,
        score(a.icao, query),
        score(a.city, query),
        score(a.name, query),
        score(a.country, query) * 0.7,
        score(cityZh, query) * 1.3,
        score(nameZh, query) * 1.25,
      );
      if (s > 0) out.push({ kind: 'airport', airport: a, score: s + 60 });
    }

    // ---- 航司 ----
    for (const al of AIRLINES) {
      const cnt = airlineCounts.get(al.icao) ?? 0;
      const s = Math.max(
        score(al.icao, query) * 1.2,
        score(al.nameZh, query),
        score(al.name, query),
      );
      if (s > 0) {
        out.push({
          kind: 'airline',
          icao: al.icao,
          nameZh: al.nameZh,
          name: al.name,
          cc: al.cc,
          count: cnt,
          score: s + (cnt > 0 ? 40 : 0),
        });
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 24);
  }, [q, snap, airports, airlineCounts]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  const commit = (h: Hit) => {
    if (h.kind === 'flight') {
      selectFlight(h.flight.callsign);
      onClose();
    } else if (h.kind === 'airport') {
      selectAirport(h.airport.iata);
      onClose();
    } else {
      // 航司：把筛选设为只看这家
      const { patchFlightFilter, toggleFilterPanel, filterOpen } = useStore.getState();
      patchFlightFilter({ airlines: [h.icao], query: '' });
      if (!filterOpen) toggleFilterPanel();
      onClose();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (hits[active]) commit(hits[active]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  // 选中项滚入视野
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="gsearch-backdrop" onClick={onClose} role="presentation">
      <div
        className="gsearch"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="全局搜索"
      >
        <div className="gsearch-input-row">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="gsearch-icon">
            <circle cx="11" cy="11" r="7" />
            <path d="M16.5 16.5L21 21" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className="gsearch-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索航班 / 机场 / 航司…"
            spellCheck={false}
            aria-label="搜索"
          />
          <kbd className="gsearch-kbd">Esc</kbd>
        </div>

        {q.trim() === '' && (
          <div className="gsearch-hint">
            <div className="gsearch-hint-row">
              <kbd>↑</kbd><kbd>↓</kbd><span>选择</span>
              <kbd>Enter</kbd><span>确认</span>
            </div>
            <div className="gsearch-hint-examples">
              试试 <b>BAW</b> · <b>JFK</b> · <b>东京</b> · <b>B77</b>
            </div>
          </div>
        )}

        {q.trim() !== '' && hits.length === 0 && (
          <div className="gsearch-empty">没有匹配「{q.trim()}」的结果</div>
        )}

        <div className="gsearch-list" ref={listRef}>
          {hits.map((h, i) => (
            <button
              key={
                h.kind === 'flight'
                  ? `f-${h.flight.callsign}`
                  : h.kind === 'airport'
                    ? `a-${h.airport.iata}`
                    : `l-${h.icao}`
              }
              className="gsearch-row"
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(h)}
              type="button"
            >
              {h.kind === 'flight' && (
                <>
                  <span className="gs-kind" data-k="flight">航班</span>
                  <span className="gs-main mono">{h.flight.callsign}</span>
                  <span className="gs-sub">
                    {(() => {
                      const { airline } = parseCallsign(h.flight.callsign);
                      return airline ? `${flagEmoji(airline.cc)} ${airline.nameZh}` : h.flight.type || '—';
                    })()}
                  </span>
                  <span className="gs-meta mono">
                    {h.flight.origin !== '—' && h.flight.destination !== '—'
                      ? `${h.flight.origin}→${h.flight.destination}`
                      : `FL${Math.round(h.flight.altitudeM / 30.48)}`}
                  </span>
                </>
              )}
              {h.kind === 'airport' && (
                <>
                  <span className="gs-kind" data-k="airport">机场</span>
                  <span className="gs-main mono">{h.airport.iata}</span>
                  <span className="gs-sub">
                    {CITY_ZH[h.airport.iata] ?? h.airport.city}
                  </span>
                  <span className="gs-meta">
                    {CITY_ZH[h.airport.iata] ? h.airport.city : h.airport.country}
                  </span>
                </>
              )}
              {h.kind === 'airline' && (
                <>
                  <span className="gs-kind" data-k="airline">航司</span>
                  <span className="gs-main mono">{h.icao}</span>
                  <span className="gs-sub">
                    {flagEmoji(h.cc)} {h.nameZh}
                  </span>
                  <span className="gs-meta mono">
                    {h.count > 0 ? `${h.count} 架在场` : '当前无'}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>

        {active >= 0 && hits[active]?.kind === 'airport' && (
          <div className="gsearch-actions">
            <button
              type="button"
              onClick={() => {
                const h = hits[active];
                if (h.kind !== 'airport') return;
                setEndpoints(h.airport, to);
                onClose();
              }}
            >
              设为出发
            </button>
            <button
              type="button"
              onClick={() => {
                const h = hits[active];
                if (h.kind !== 'airport') return;
                setEndpoints(from, h.airport);
                onClose();
              }}
            >
              设为到达
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
