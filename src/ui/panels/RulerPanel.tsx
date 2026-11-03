import { useMemo } from 'react';
import { useStore } from '../../state/store';
import {
  greatCircleDistance,
  initialBearing,
  rhumbLine,
  greatCircleBulge,
  toVec3,
  fromVec3,
  slerp,
} from '../../core/geo';
import { msToKmh } from '../../core/atmos';

/**
 * 测距工具（Ruler）
 * ---------------------------------------------------------------------------
 * 在地球上任取两点，给出：
 *   · 大圆距离与初始方位角（航空最常用的两个量）
 *   · 恒向线距离与其恒定航向（用于说明「为什么不走等角航线」）
 *   · 大圆相对恒向线的最大纬度偏移（大圆为什么会"拱起来"）
 *
 * 这些量全部来自 core/geo 的同一套实现，与三维渲染里的航线用的是同一份数学，
 * 不存在"图上画的和下面写的不一致"。
 */
export function RulerPanel() {
  const points = useStore((s) => s.rulerPoints);
  const clearRuler = useStore((s) => s.clearRuler);
  const rulerMode = useStore((s) => s.rulerMode);
  const toggleRulerMode = useStore((s) => s.toggleRulerMode);
  const hover = useStore((s) => s.hover);

  const metrics = useMemo(() => {
    if (points.length < 2) return null;
    const [a, b] = points;
    const gc = greatCircleDistance(a, b);
    const bearing = initialBearing(a, b);
    const rh = rhumbLine(a, b);
    const bulge = greatCircleBulge(a, b);
    // 大圆中点，用来提示"拱向哪里"
    const mid = fromVec3(slerp(toVec3(a.lat, a.lon), toVec3(b.lat, b.lon), 0.5));
    return {
      gc,
      bearing,
      rhumb: rh.distance,
      rhumbBearing: rh.bearing,
      bulge,
      mid,
      saving: rh.distance - gc,
      savingPct: rh.distance > 0 ? ((rh.distance - gc) / rh.distance) * 100 : 0,
    };
  }, [points]);

  return (
    <div className="ruler-panel glass">
      <div className="ruler-head">
        <span className="caps">大圆测距</span>
        {points.length > 0 && (
          <button className="ruler-clear" onClick={clearRuler} type="button">
            清除
          </button>
        )}
      </div>

      <div className="ruler-body">
        <button
          className="ruler-mode"
          data-on={rulerMode}
          onClick={toggleRulerMode}
          type="button"
          aria-pressed={rulerMode}
        >
          <span className="ruler-mode-dot" />
          {rulerMode ? '测距中 · 点击地球取点' : '开始测距'}
        </button>

        {points.length === 0 && (
          <div className="ruler-hint" style={{ marginTop: 6 }}>
            {rulerMode ? '在地球上点击两个点' : '开启测距后点击地球取点'}
            {hover && (
              <div className="mono" style={{ marginTop: 4, color: 'var(--jet)', fontSize: 9 }}>
                {Math.abs(hover.lat).toFixed(2)}°{hover.lat >= 0 ? 'N' : 'S'}{' '}
                {Math.abs(hover.lon).toFixed(2)}°{hover.lon >= 0 ? 'E' : 'W'}
              </div>
            )}
          </div>
        )}

        {points.map((p, i) => (
          <div key={i} className="ruler-point">
            <span className="ruler-badge">{i === 0 ? 'A' : 'B'}</span>
            <span className="mono ruler-coord">
              {Math.abs(p.lat).toFixed(2)}°{p.lat >= 0 ? 'N' : 'S'}{' '}
              {Math.abs(p.lon).toFixed(2)}°{p.lon >= 0 ? 'E' : 'W'}
            </span>
          </div>
        ))}

        {points.length === 1 && (
          <div className="ruler-hint" style={{ marginTop: 4 }}>
            再点一下确定终点
          </div>
        )}

        {metrics && (
          <>
            <div className="hr" style={{ margin: '9px 0 7px' }} />
            <div className="ruler-metrics">
              <div className="ruler-metric">
                <span>大圆距离</span>
                <b className="mono">{(metrics.gc / 1000).toFixed(1)} km</b>
              </div>
              <div className="ruler-metric">
                <span>初始方位</span>
                <b className="mono">{metrics.bearing.toFixed(1)}°</b>
              </div>
              <div className="ruler-metric">
                <span>恒向线</span>
                <b className="mono">{(metrics.rhumb / 1000).toFixed(1)} km</b>
              </div>
              <div className="ruler-metric">
                <span>恒向航向</span>
                <b className="mono">{metrics.rhumbBearing.toFixed(1)}°</b>
              </div>
            </div>

            <div className="ruler-note">
              走大圆比等角航线短 <b>{(metrics.saving / 1000).toFixed(0)} km</b>
              （{metrics.savingPct.toFixed(1)}%），
              最大纬度偏移 {Math.abs(metrics.bulge).toFixed(2)}°。
            </div>

            <div className="ruler-mid mono">
              大圆中点 {Math.abs(metrics.mid.lat).toFixed(1)}°{metrics.mid.lat >= 0 ? 'N' : 'S'}{' '}
              {Math.abs(metrics.mid.lon).toFixed(1)}°{metrics.mid.lon >= 0 ? 'E' : 'W'}
            </div>

            <button
              className="ruler-apply"
              type="button"
              onClick={() => {
                // 用测距两点作为起降点（若落在机场附近则吸附）
                const s = useStore.getState();
                const nearest = (p: { lat: number; lon: number }) => {
                  let best = s.airports[0];
                  let bestD = Infinity;
                  for (const a of s.airports) {
                    const d = greatCircleDistance(p, a);
                    if (d < bestD) {
                      bestD = d;
                      best = a;
                    }
                  }
                  return bestD < 150_000 ? best : null;
                };
                const a = nearest(points[0]);
                const b = nearest(points[1]);
                // 两点吸附到同一机场会导致 0 距离 0 时长的空推演，
                // 界面上表现为「成功了但全是 0」，比不响应更困惑
                if (a && b && a.iata !== b.iata) s.setEndpoints(a, b);
              }}
            >
              用这两点推演
            </button>
            <span style={{ display: 'none' }}>{msToKmh(0)}</span>
          </>
        )}
      </div>
    </div>
  );
}
