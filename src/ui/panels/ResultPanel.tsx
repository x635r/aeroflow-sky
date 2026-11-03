import type { Comparison } from '../../sim/routeEngine';
import { formatHm, msToKmh } from '../../core/atmos';
import { WIND_RAMP, sampleRamp, toCss } from '../../render/palette';

type Props = {
  result: Comparison | null;
  fromCode: string;
  toCode: string;
};

function dirLabel(fromLon: number, toLon: number): 'east' | 'west' {
  let d = toLon - fromLon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d >= 0 ? 'east' : 'west';
}

export function ResultPanel({ result, fromCode, toCode }: Props) {
  if (!result) {
    return (
      <div className="panel-right glass-strong">
        <div className="panel-head">
          <span className="caps">推演结果</span>
        </div>
        <div className="panel-body" style={{ padding: '34px 20px', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.9 }}>
            选择出发与到达机场
            <br />
            开始计算借风航线
          </div>
        </div>
      </div>
    );
  }

  const { optimal, gc, reverse, timeSaved } = result;
  const forwardDir = dirLabel(optimal.points[0].lon, optimal.points[optimal.points.length - 1].lon);
  const fwdTime = optimal.duration;
  const backTime = reverse.duration;
  const eastTime = forwardDir === 'east' ? fwdTime : backTime;
  const westTime = forwardDir === 'east' ? backTime : fwdTime;
  const deltaMin = Math.abs(westTime - eastTime) / 60;

  const fwdKmh = msToKmh(optimal.avgGroundSpeed);
  const revKmh = msToKmh(reverse.avgGroundSpeed);
  const gcKmh = msToKmh(gc.avgGroundSpeed);

  const saved = timeSaved / 60;
  const extraKm = optimal.extraDistance / 1000;

  return (
    <div className="panel-right glass-strong">
      <div className="panel-head">
        <span className="caps">
          推演结果 · {fromCode} → {toCode}
        </span>
        <span
          className="mono"
          style={{ fontSize: 10, color: 'var(--text-faint)', letterSpacing: '0.02em' }}
        >
          {Math.round(optimal.distance / 1000).toLocaleString('en-US')} km
        </span>
      </div>

      <div className="versus">
        <div className="versus-cell">
          <div className="dir" data-tone="east">
            <span aria-hidden>→</span> 顺风方向
          </div>
          <div className="time">{formatHm(eastTime)}</div>
          <div className="sub">{Math.round(eastTime === fwdTime ? fwdKmh : revKmh)} km/h</div>
        </div>
        <div className="versus-mid">
          <div className="versus-delta">Δ {deltaMin.toFixed(0)}′</div>
          <span style={{ fontSize: 8, color: 'var(--text-faint)' }}>时间差</span>
        </div>
        <div className="versus-cell">
          <div className="dir" data-tone="west">
            <span aria-hidden>←</span> 逆风方向
          </div>
          <div className="time">{formatHm(westTime)}</div>
          <div className="sub">{Math.round(westTime === fwdTime ? fwdKmh : revKmh)} km/h</div>
        </div>
      </div>

      <div className="panel-body" style={{ padding: '2px 0 0' }}>
        <div className="metrics">
          <div className="metric-row">
            <span className="metric-label">借风航线平均地速</span>
            <span className="metric-value" data-tone="good">
              {fwdKmh.toFixed(0)}
              <small>km/h</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">大圆航线平均地速</span>
            <span className="metric-value">
              {gcKmh.toFixed(0)}
              <small>km/h</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">
              {Math.abs(saved) < 0.5 ? '借风收益' : saved > 0 ? '借风提速' : '借风损失'}
            </span>
            <span className="metric-value" data-tone={saved > 0.5 ? 'good' : saved < -0.5 ? 'warn' : undefined}>
              {Math.abs(saved) < 0.5 ? '≈' : saved > 0 ? '−' : '+'}
              {Math.abs(saved) < 0.5 ? '0' : Math.abs(saved).toFixed(0)}
              <small>分钟</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">相对大圆绕飞</span>
            <span className="metric-value" data-tone={extraKm > 120 ? 'warn' : undefined}>
              +{extraKm.toFixed(0)}
              <small>km</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">平均顺风分量</span>
            <span
              className="metric-value"
              data-tone={optimal.avgWindAlong > 5 ? 'good' : optimal.avgWindAlong < -5 ? 'bad' : undefined}
            >
              {optimal.avgWindAlong >= 0 ? '+' : ''}
              {optimal.avgWindAlong.toFixed(0)}
              <small>m/s</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">航路最大风速</span>
            <span
              className="metric-value"
              style={{ color: toCss(sampleRamp(WIND_RAMP, Math.min(1, optimal.maxWind / 110))) }}
            >
              {msToKmh(optimal.maxWind).toFixed(0)}
              <small>km/h</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">湍流航段占比</span>
            <span
              className="metric-value"
              data-tone={
                optimal.catFraction > 0.5 ? 'bad' : optimal.catFraction > 0.25 ? 'warn' : undefined
              }
            >
              {(optimal.catFraction * 100).toFixed(0)}
              <small>%</small>
            </span>
          </div>
          <div className="metric-row">
            <span className="metric-label">最大偏离大圆</span>
            <span className="metric-value">
              {optimal.deviationDeg.toFixed(1)}
              <small>°</small>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
