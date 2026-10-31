import { useMemo } from 'react';
import { useStore } from '../../state/store';
import { stepTimes } from '../../data/windField';

function fmtUTC(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

function fmtShort(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCHours())}Z`;
}

export function TimeBar() {
  const field = useStore((s) => s.field);
  const timeMs = useStore((s) => s.timeMs);
  const setTime = useStore((s) => s.setTime);

  const times = useMemo(() => (field ? stepTimes(field) : []), [field]);

  if (times.length === 0) return null;

  const t0 = times[0];
  const t1 = times[times.length - 1];
  const span = Math.max(1, t1 - t0);
  const pos = Math.max(0, Math.min(1, (timeMs - t0) / span));

  // 距当前时刻的小时差
  const hoursAhead = (timeMs - t0) / 3_600_000;
  const cycle = field?.header.cycle ?? '';

  return (
    <div className="timebar glass-strong">
      <div className="timebar-head">
        <div>
          <div className="timebar-now">{fmtUTC(timeMs)}</div>
          <div className="timebar-sub">
            GFS 起报 {cycle.replace('T', ' ').replace(':00Z', 'Z')} · 预报时效 +
            {hoursAhead.toFixed(0)}h
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 9.5,
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span>时间轴</span>
          <span style={{ color: 'var(--jet)' }}>▸</span>
        </div>
      </div>

      <div className="track">
        <div className="track-rail">
          <div className="track-fill" style={{ width: `${pos * 100}%` }} />
        </div>
        <div className="track-ticks">
          {times.map((t) => (
            <div key={t} className="track-tick" style={{ position: 'absolute', left: `${((t - t0) / span) * 100}%` }}>
              <span>{fmtShort(t)}</span>
            </div>
          ))}
        </div>
        <div className="track-thumb" style={{ left: `${pos * 100}%` }} />
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(pos * 1000)}
          onChange={(e) => {
            const k = Number(e.target.value) / 1000;
            setTime(t0 + k * span);
          }}
          aria-label="预报时间轴"
        />
      </div>
    </div>
  );
}
