import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { WIND_RAMP, CAT_RAMP, rampToCss } from '../../render/palette';
import { probePoint, type PlanContext } from '../../sim/routeEngine';
import { msToKmh, aircraftById } from '../../core/atmos';
import { timeToStepPos } from '../../data/windField';
import { CAT_LEVELS } from '../../sim/routeEngine';

/**
 * 左下角：风速色标 + 悬停探针
 * 色标与 GPU 粒子共用同一组控制点，所以「图上的颜色」=「这里的数值」。
 *
 * 注意：这里刻意不把 store 里的派生函数（每次返回新对象）当 selector 用，
 * 否则 useSyncExternalStore 会因为快照不稳定而无限重渲染。
 */
export function WindLegend() {
  const hover = useStore((s) => s.hover);
  const field = useStore((s) => s.field);
  const pressureHpa = useStore((s) => s.pressureHpa);
  const timeMs = useStore((s) => s.timeMs);
  const aircraftId = useStore((s) => s.aircraftId);
  const mach = useStore((s) => s.mach);
  const layers = useStore((s) => s.layers);

  const ctx = useMemo<PlanContext | null>(() => {
    if (!field) return null;
    return {
      field,
      pressureHpa,
      stepPos: timeToStepPos(field, timeMs),
      aircraft: aircraftById(aircraftId),
      mach,
    };
  }, [field, pressureHpa, timeMs, aircraftId, mach]);

  const probe = useMemo(
    () => (hover && ctx ? probePoint(ctx, hover.lat, hover.lon) : null),
    [hover, ctx],
  );

  return (
    <div className="wind-legend glass">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="caps">风速 {layers.cat ? '· 湍流' : ''}</span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--text-faint)' }}>
          {layers.cat ? 'CAT 模式' : `${pressureHpa} hPa`}
        </span>
      </div>

      <div
        className="legend-bar"
        style={{ background: rampToCss(layers.cat ? CAT_RAMP : WIND_RAMP) }}
        role="img"
        aria-label="风速色标"
      />
      <div className="legend-scale">
        {layers.cat ? (
          <>
            <span>0 平滑</span>
            <span>0.5 中</span>
            <span>1.0 强</span>
          </>
        ) : (
          <>
            <span>0</span>
            <span>50</span>
            <span>100 m/s</span>
          </>
        )}
      </div>

      {probe && hover && (
        <>
          <div className="hr" style={{ margin: '9px 0 7px' }} />
          <div
            className="mono"
            style={{ fontSize: 9.5, color: 'var(--jet)', marginBottom: 4, letterSpacing: '0.02em' }}
          >
            {Math.abs(hover.lat).toFixed(1)}°{hover.lat >= 0 ? 'N' : 'S'}{' '}
            {Math.abs(hover.lon).toFixed(1)}°{hover.lon >= 0 ? 'E' : 'W'}
          </div>
          <div className="hover-grid">
            <dt>风速</dt>
            <dd>{msToKmh(probe.speed).toFixed(0)} km/h</dd>
            <dt>风向</dt>
            <dd>{probe.direction.toFixed(0)}°</dd>
            <dt>静温</dt>
            <dd>{probe.tempC.toFixed(0)}°C</dd>
            <dt>湍流</dt>
            <dd
              style={{
                color:
                  probe.cat > CAT_LEVELS.severe
                    ? 'var(--danger)'
                    : probe.cat > CAT_LEVELS.moderate
                      ? 'var(--hot)'
                      : 'var(--text)',
              }}
            >
              {probe.cat.toFixed(2)}
            </dd>
          </div>
        </>
      )}
    </div>
  );
}
