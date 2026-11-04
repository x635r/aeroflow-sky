import { useMemo, useState } from 'react';
import { useStore } from '../../state/store';
import {
  ALTITUDE_BANDS_FILTER,
  groupByAirline,
  groupByType,
  altitudeHistogram,
  applyFilter,
  isFilterActive,
  type AltitudeBandId,
} from '../../data/flightFilter';
import { flagEmoji } from '../../data/airlines';

/**
 * 航班筛选面板
 * ---------------------------------------------------------------------------
 * FR24 的核心生产力工具。设计取向：
 *
 *   · **先给分布，再给筛选**：打开面板先看到「当前区航班按高度/航司/机型
 *     怎么分布」，用户才知道该筛什么。直接甩一排空输入框是反模式。
 *   · **数字永远实时**：每一行在旁边显示"选中后会剩多少架"，
 *     避免点了三个条件后发现结果为空。
 *   · **可以叠加**：高度带多选、航司多选、文本 + 组合，全部 AND。
 */
export function FilterPanel({ onClose }: { onClose: () => void }) {
  const snap = useStore((s) => s.liveSnapshot);
  const filter = useStore((s) => s.flightFilter);
  const patch = useStore((s) => s.patchFlightFilter);
  const reset = useStore((s) => s.resetFlightFilter);
  const [showAirlines, setShowAirlines] = useState(true);
  const [showTypes, setShowTypes] = useState(false);

  const flights = snap?.flights ?? [];

  const visible = useMemo(() => applyFilter(flights, filter), [flights, filter]);
  const airlines = useMemo(() => groupByAirline(flights), [flights]);
  const types = useMemo(() => groupByType(flights), [flights]);
  const hist = useMemo(() => altitudeHistogram(flights), [flights]);

  const toggleBand = (id: AltitudeBandId) => {
    const has = filter.bands.includes(id);
    patch({ bands: has ? filter.bands.filter((b) => b !== id) : [...filter.bands, id] });
  };

  const toggleAirline = (icao: string) => {
    const has = filter.airlines.includes(icao);
    patch({
      airlines: has ? filter.airlines.filter((a) => a !== icao) : [...filter.airlines, icao],
    });
  };

  const toggleType = (t: string) => {
    const has = filter.types.includes(t);
    patch({ types: has ? filter.types.filter((x) => x !== t) : [...filter.types, t] });
  };

  /** 预估：若把某条件加入当前筛选，会剩多少架 */
  const previewBand = (id: AltitudeBandId) =>
    applyFilter(flights, { ...filter, bands: [...filter.bands, id] }).length;
  const previewAirline = (icao: string) =>
    applyFilter(flights, { ...filter, airlines: [...filter.airlines, icao] }).length;

  return (
    <div className="filter-panel glass-strong">
      <div className="fp-head">
        <div>
          <span className="caps">航班筛选</span>
          <div className="fp-count mono">
            {visible.length} / {flights.length} 架
          </div>
        </div>
        <div className="fp-head-actions">
          {isFilterActive(filter) && (
            <button className="fp-reset" onClick={reset} type="button">
              清除
            </button>
          )}
          <button className="fp-close" onClick={onClose} type="button" aria-label="关闭">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="fp-body">
        {/* 文本搜索 */}
        <div className="fp-section">
          <input
            className="fp-search"
            value={filter.query}
            onChange={(e) => patch({ query: e.target.value })}
            placeholder="呼号 / 航司 / 机型 / 机场"
            spellCheck={false}
            aria-label="搜索航班"
          />
        </div>

        {/* 高度带 + 分布条 */}
        <div className="fp-section">
          <div className="fp-label-row">
            <span className="caps">高度带</span>
            <span className="fp-hint">点选可多选</span>
          </div>
          <div className="fp-hist">
            {hist.map((b) => {
              const on = filter.bands.includes(b.id);
              const max = Math.max(...hist.map((x) => x.count), 1);
              const pct = (b.count / max) * 100;
              const wouldBe = filter.bands.includes(b.id) ? b.count : previewBand(b.id);
              return (
                <button
                  key={b.id}
                  className="fp-hist-col"
                  data-on={on}
                  data-empty={b.count === 0}
                  onClick={() => toggleBand(b.id)}
                  type="button"
                  aria-pressed={on}
                  title={`${b.label}：${b.count} 架${filter.bands.length ? `（加入后剩 ${wouldBe}）` : ''}`}
                >
                  <span className="fp-hist-num mono">{b.count}</span>
                  <span className="fp-hist-bar">
                    <span className="fp-hist-fill" style={{ height: `${Math.max(pct, 3)}%` }} />
                  </span>
                  <span className="fp-hist-label">{b.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 快捷条件 */}
        <div className="fp-section">
          <div className="fp-chips">
            <button
              className="fp-chip"
              data-on={filter.windMode === 'tail'}
              onClick={() => patch({ windMode: filter.windMode === 'tail' ? 'any' : 'tail' })}
              type="button"
            >
              顺风
            </button>
            <button
              className="fp-chip"
              data-on={filter.windMode === 'head'}
              onClick={() => patch({ windMode: filter.windMode === 'head' ? 'any' : 'head' })}
              type="button"
            >
              逆风
            </button>
            <button
              className="fp-chip"
              data-on={filter.turbulenceOnly}
              data-tone="warn"
              onClick={() => patch({ turbulenceOnly: !filter.turbulenceOnly })}
              type="button"
            >
              颠簸中
            </button>
          </div>
        </div>

        {/* 航司 */}
        {airlines.length > 0 && (
          <div className="fp-section">
            <button
              className="fp-label-row fp-toggle"
              onClick={() => setShowAirlines((v) => !v)}
              type="button"
              aria-expanded={showAirlines}
            >
              <span className="caps">航司 · {airlines.length}</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                style={{ transform: showAirlines ? 'none' : 'rotate(-90deg)', transition: 'transform .16s' }}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" />
              </svg>
            </button>
            {showAirlines && (
              <div className="fp-list">
                {airlines.slice(0, 14).map((a) => {
                  const on = filter.airlines.includes(a.icao);
                  const wouldBe = previewAirline(a.icao);
                  return (
                    <button
                      key={a.icao}
                      className="fp-row"
                      data-on={on}
                      onClick={() => toggleAirline(a.icao)}
                      type="button"
                      aria-pressed={on}
                    >
                      <span className="fp-flag">{flagEmoji(a.cc)}</span>
                      <span className="fp-row-name">{a.nameZh}</span>
                      <span className="fp-row-code mono">{a.icao}</span>
                      <span className="fp-row-num mono">
                        {on ? a.count : wouldBe}
                        <small>/{a.count}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 机型 */}
        {types.length > 0 && (
          <div className="fp-section">
            <button
              className="fp-label-row fp-toggle"
              onClick={() => setShowTypes((v) => !v)}
              type="button"
              aria-expanded={showTypes}
            >
              <span className="caps">机型 · {types.length}</span>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                style={{ transform: showTypes ? 'none' : 'rotate(-90deg)', transition: 'transform .16s' }}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" />
              </svg>
            </button>
            {showTypes && (
              <div className="fp-chips">
                {types.slice(0, 12).map((t) => (
                  <button
                    key={t.type}
                    className="fp-chip"
                    data-on={filter.types.includes(t.type)}
                    onClick={() => toggleType(t.type)}
                    type="button"
                  >
                    {t.type}
                    <span className="fp-chip-n">{t.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {flights.length === 0 && (
          <div className="fp-empty">暂无航班数据</div>
        )}
        {flights.length > 0 && visible.length === 0 && (
          <div className="fp-empty">当前条件无匹配航班</div>
        )}
      </div>
    </div>
  );
}

export const _bands = ALTITUDE_BANDS_FILTER;
