import { useMemo } from 'react';
import type { RoutePoint } from '../../sim/routeEngine';
import { msToKmh } from '../../core/atmos';
import { WIND_RAMP, CAT_RAMP, sampleRamp, toCss } from '../../render/palette';

type Props = {
  points: RoutePoint[];
  /** 悬停位置对应的航路点索引 */
  cursorIndex?: number | null;
};

const W = 300;
const H = 104;
const PAD_L = 3;
const PAD_R = 3;
const PAD_T = 8;
const PAD_B = 20;

/**
 * 航路剖面图
 * ---------------------------------------------------------------------------
 * 横轴：沿航路的累计距离
 * 纵轴：地速（km/h）—— 产品要讲的是「风怎么改变地速」，
 *       所以剖面画地速而不是高度（高度恒定）。
 *
 * 叠加两条带：
 *   · 上层细带：湍流指数（琥珀 → 洋红）
 *   · 底部条：顺风（青绿）/ 逆风（橙红）
 *
 * 这样一眼就能读出「哪里吃到急流、哪里在搏风、哪里会颠」。
 */
export function RouteProfile({ points, cursorIndex }: Props) {
  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const total = points[points.length - 1].distance || 1;
    const speeds = points.map((p) => msToKmh(p.groundSpeed));
    const minS = Math.min(...speeds);
    const maxS = Math.max(...speeds);
    const span = Math.max(maxS - minS, 40);
    const lo = minS - span * 0.12;
    const hi = maxS + span * 0.12;

    const x = (d: number) => PAD_L + (d / total) * (W - PAD_L - PAD_R);
    const y = (s: number) => PAD_T + (1 - (s - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

    const speedPath = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.distance).toFixed(2)},${y(speeds[i]).toFixed(2)}`)
      .join(' ');

    // 填充分区：基线取最低值
    const areaPath =
      `M${x(0).toFixed(2)},${y(lo).toFixed(2)} ` +
      points.map((p, i) => `L${x(p.distance).toFixed(2)},${y(speeds[i]).toFixed(2)}`).join(' ') +
      ` L${x(total).toFixed(2)},${y(lo).toFixed(2)} Z`;

    // 每段的风分量条（24 段聚合，避免 SVG 节点过多）
    const bands = 36;
    const bandData: Array<{ x0: number; w: number; along: number; cat: number }> = [];
    for (let i = 0; i < bands; i++) {
      const i0 = Math.floor((i / bands) * points.length);
      const i1 = Math.max(i0 + 1, Math.floor(((i + 1) / bands) * points.length));
      const slice = points.slice(i0, i1);
      if (!slice.length) continue;
      const along = slice.reduce((s, p) => s + p.windAlong, 0) / slice.length;
      const cat = Math.max(...slice.map((p) => p.cat));
      const d0 = points[i0].distance;
      const d1 = points[Math.min(points.length - 1, i1)].distance;
      bandData.push({ x0: d0, w: Math.max(d1 - d0, total / bands * 0.92), along, cat });
    }

    const cursor =
      cursorIndex != null && cursorIndex >= 0 && cursorIndex < points.length
        ? {
            x: x(points[cursorIndex].distance),
            y: y(speeds[cursorIndex]),
            speed: speeds[cursorIndex],
            point: points[cursorIndex],
          }
        : null;

    return { x, y, speedPath, areaPath, lo, hi, total, minS, maxS, bandData, cursor, speeds };
  }, [points, cursorIndex]);

  if (!geom) {
    return (
      <div className="profile-wrap">
        <div style={{ height: H, display: 'grid', placeItems: 'center', color: 'var(--text-faint)', fontSize: 10 }}>
          等待航路数据
        </div>
      </div>
    );
  }

  const { speedPath, areaPath, bandData, cursor, x, y, lo, hi, minS, maxS, total } = geom;
  const bandTop = H - PAD_B + 3;
  const bandH = 5;
  const maxAbs = 60;

  return (
    <div className="profile-wrap">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 5,
        }}
      >
        <span className="caps">航路剖面 · 地速</span>
        <span className="mono" style={{ fontSize: 9, color: 'var(--text-faint)' }}>
          {minS.toFixed(0)}–{maxS.toFixed(0)} km/h
        </span>
      </div>

      <svg className="profile-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label="沿航路的地速剖面，含顺风与湍流标记">
        <defs>
          <linearGradient id="speedFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(53,208,245,0.42)" />
            <stop offset="65%" stopColor="rgba(53,208,245,0.10)" />
            <stop offset="100%" stopColor="rgba(53,208,245,0)" />
          </linearGradient>
          <clipPath id="plotClip">
            <rect x={PAD_L} y={PAD_T - 4} width={W - PAD_L - PAD_R} height={H - PAD_T - PAD_B + 4} />
          </clipPath>
        </defs>

        {/* 水平参考线 */}
        {[0, 0.5, 1].map((t) => {
          const yy = PAD_T + t * (H - PAD_T - PAD_B);
          return (
            <line
              key={t}
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yy}
              y2={yy}
              stroke="rgba(120,190,230,0.09)"
              strokeDasharray="2 3"
            />
          );
        })}

        <g clipPath="url(#plotClip)">
          {/* 顺风/逆风条 */}
          {bandData.map((b, i) => {
            const t = Math.max(-1, Math.min(1, b.along / maxAbs));
            const col = t >= 0
              ? `rgba(127,240,210,${0.2 + t * 0.62})`
              : `rgba(255,120,90,${0.22 + -t * 0.58})`;
            return (
              <rect
                key={i}
                x={x(b.x0)}
                y={bandTop}
                width={Math.max(1, (b.w / total) * (W - PAD_L - PAD_R))}
                height={bandH}
                fill={col}
              />
            );
          })}

          {/* 湍流带 */}
          {bandData.map((b, i) => {
            if (b.cat < 0.3) return null;
            const c = sampleRamp(CAT_RAMP, Math.min(1, (b.cat - 0.3) / 0.6));
            return (
              <rect
                key={`c${i}`}
                x={x(b.x0)}
                y={PAD_T - 2}
                width={Math.max(1, (b.w / total) * (W - PAD_L - PAD_R))}
                height={2.5}
                fill={toCss(c, 0.35 + b.cat * 0.6)}
                rx={1}
              />
            );
          })}

          {/* 地速面积与曲线 */}
          <path d={areaPath} fill="url(#speedFill)" />
          <path
            d={speedPath}
            fill="none"
            stroke="#7ff0d2"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 0 4px rgba(127,240,210,0.55))' }}
          />

          {cursor && (
            <>
              <line
                x1={cursor.x}
                x2={cursor.x}
                y1={PAD_T}
                y2={H - PAD_B + bandH + 2}
                stroke="rgba(255,255,255,0.4)"
                strokeWidth={0.8}
                strokeDasharray="2 2"
              />
              <circle cx={cursor.x} cy={cursor.y} r={2.6} fill="#fff" stroke="#35d0f5" strokeWidth={1} />
            </>
          )}
        </g>

        {/* 轴标注 */}
        <text x={PAD_L} y={H - 3} fill="#5c7386" fontSize={7} fontFamily="var(--font-mono)">
          0
        </text>
        <text x={W / 2} y={H - 3} fill="#5c7386" fontSize={7} textAnchor="middle" fontFamily="var(--font-mono)">
          {Math.round(total / 2000)} km
        </text>
        <text x={W - PAD_R} y={H - 3} fill="#5c7386" fontSize={7} textAnchor="end" fontFamily="var(--font-mono)">
          {Math.round(total / 1000)} km
        </text>
        <text x={PAD_L - 1} y={PAD_T + 4} fill="#4a6070" fontSize={6.5} fontFamily="var(--font-mono)">
          {Math.round(hi)}
        </text>
        <text x={PAD_L - 1} y={H - PAD_B - 1} fill="#4a6070" fontSize={6.5} fontFamily="var(--font-mono)">
          {Math.round(lo)}
        </text>
        {cursor && (
          <text
            x={Math.min(W - 40, Math.max(20, cursor.x))}
            y={Math.max(11, cursor.y - 5)}
            fill="#cfe9f7"
            fontSize={8}
            textAnchor="middle"
            fontFamily="var(--font-mono)"
            fontWeight={600}
          >
            {cursor.speed.toFixed(0)}
          </text>
        )}
        {void y}
        {void minS}
      </svg>

      <div className="profile-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'rgba(127,240,210,0.8)' }} />
          顺风
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'rgba(255,120,90,0.75)' }} />
          逆风
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: '#ff9f4a' }} />
          颠簸区
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: '#7ff0d2', height: 2 }} />
          地速
        </span>
        <span className="legend-item" style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>
          {WIND_RAMP.length > 0 ? `最大顺风 ${Math.max(...bandData.map((b) => b.along)).toFixed(0)} m/s` : ''}
        </span>
      </div>
    </div>
  );
}
