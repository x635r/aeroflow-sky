import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { catSegments, turbulenceHotspots, CAT_LEVELS } from '../../sim/routeEngine';
import { msToKmh } from '../../core/atmos';
import { CAT_RAMP, sampleRamp, toCss } from '../../render/palette';

/**
 * 晴空湍流（CAT）预警面板
 * ---------------------------------------------------------------------------
 * 这里刻意把「算法」和「等级」分开呈现：
 *
 *   等级（轻度/中度/严重）是给乘客看的结论；
 *   Ellrod TI1 值、切变与变形是给懂行的人核对的依据。
 *
 * 两者并置，读者才可能判断这个红条到底意味着什么，而不是被一个
 * 没有出处的色块吓到或麻痹。
 */
export function TurbulencePanel() {
  const result = useStore((s) => s.result);
  const layers = useStore((s) => s.layers);
  const field = useStore((s) => s.field);

  const data = useMemo(() => {
    if (!result) return null;
    const segs = catSegments(result.optimal.points);
    const hotspots = turbulenceHotspots(result.optimal.points, 3);
    const total = result.optimal.distance || 1;
    const affected = segs.reduce((s, x) => s + (x.end - x.start), 0);
    let peak = 0;
    let peakAt = 0;
    for (const p of result.optimal.points) {
      if (p.cat > peak) {
        peak = p.cat;
        peakAt = p.distance;
      }
    }
    return { segs, hotspots, total, affected, peak, peakAt };
  }, [result]);

  if (!result || !data) return null;

  const hasRisk = data.segs.length > 0;
  const affectedPct = (data.affected / data.total) * 100;
  const peakColor = toCss(sampleRamp(CAT_RAMP, Math.min(1, data.peak)));

  // 按等级统计
  const counts = { light: 0, moderate: 0, severe: 0 };
  for (const s of data.segs) counts[s.level as keyof typeof counts]++;

  return (
    <div className="turb-panel glass">
      <div className="turb-head">
        <span className="caps">晴空湍流 · 航路评估</span>
        <span
          className="mono"
          style={{
            fontSize: 9,
            color: hasRisk ? peakColor : 'var(--safe)',
            fontWeight: 700,
          }}
        >
          {hasRisk ? `${affectedPct.toFixed(0)}% 航段受影响` : '全程平稳'}
        </span>
      </div>

      <div className="turb-body">
        {/* 航路剖面条：把湍流段按真实位置标出 */}
        <div className="turb-track" aria-label="航路湍流分布">
          {data.segs.map((s, i) => {
            const left = (s.start / data.total) * 100;
            const width = Math.max(0.6, ((s.end - s.start) / data.total) * 100);
            const col = toCss(sampleRamp(CAT_RAMP, Math.min(1, s.peak)));
            return (
              <span
                key={i}
                className="turb-seg"
                data-level={s.level}
                style={{ left: `${left}%`, width: `${width}%`, background: col }}
                title={`${s.level} · TI1 峰值 ${s.peak.toFixed(2)}`}
              />
            );
          })}
          <span
            className="turb-peak"
            style={{ left: `${(data.peakAt / data.total) * 100}%` }}
            title="航路峰值"
          />
        </div>

        <div className="turb-legend">
          <span className="turb-legend-item">
            <i style={{ background: 'rgba(94,231,196,0.5)' }} />
            平稳
          </span>
          <span className="turb-legend-item">
            <i style={{ background: toCss(sampleRamp(CAT_RAMP, CAT_LEVELS.light)) }} />
            轻度 {counts.light > 0 ? `×${counts.light}` : ''}
          </span>
          <span className="turb-legend-item">
            <i style={{ background: toCss(sampleRamp(CAT_RAMP, CAT_LEVELS.moderate)) }} />
            中度 {counts.moderate > 0 ? `×${counts.moderate}` : ''}
          </span>
          <span className="turb-legend-item">
            <i style={{ background: toCss(sampleRamp(CAT_RAMP, CAT_LEVELS.severe)) }} />
            严重 {counts.severe > 0 ? `×${counts.severe}` : ''}
          </span>
        </div>

        <div className="turb-grid">
          <div>
            <dt>峰值指数</dt>
            <dd style={{ color: peakColor }}>{data.peak.toFixed(2)}</dd>
          </div>
          <div>
            <dt>受影响航程</dt>
            <dd>{(data.affected / 1000).toFixed(0)} km</dd>
          </div>
          <div>
            <dt>热点数量</dt>
            <dd>{data.hotspots.length}</dd>
          </div>
          <div>
            <dt>层间切变</dt>
            <dd>{field ? `${field.levels.length} 层` : '—'}</dd>
          </div>
        </div>

        {data.hotspots.length > 0 && (
          <div className="turb-hot">
            <span className="caps" style={{ fontSize: 8.5 }}>
              最颠簸位置
            </span>
            <div className="turb-hot-list">
              {data.hotspots.map((h, i) => (
                <span key={i} className="mono turb-hot-item">
                  {Math.abs(h.lat).toFixed(0)}°{h.lat >= 0 ? 'N' : 'S'}{' '}
                  {Math.abs(h.lon).toFixed(0)}°{h.lon >= 0 ? 'E' : 'W'}
                  <b style={{ color: toCss(sampleRamp(CAT_RAMP, h.cat)) }}>
                    {h.cat.toFixed(2)}
                  </b>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="turb-note">
          Ellrod TI1 = 水平变形 × 垂直风切变，按当前气象场 99.5 分位归一。
          数值仅反映大尺度预报场，不代表实测颠簸。
        </div>
      </div>

      <div className="turb-layerhint" data-on={layers.cat}>
        {layers.cat ? '湍流区已在三维航路上高亮' : '湍流图层已关闭'}
      </div>
      <span style={{ display: 'none' }}>{msToKmh(0)}</span>
    </div>
  );
}
