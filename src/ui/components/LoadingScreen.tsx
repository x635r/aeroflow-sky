import { useEffect, useState } from 'react';
import type { LoadingStage } from '../../state/store';

type Props = {
  stage: LoadingStage;
  progress: number;
  done: boolean;
};

const STAGE_TEXT: Record<string, string> = {
  idle: '初始化渲染管线',
  wind: '载入 NOAA GFS 高空风场',
  static: '构建地表与机场网络',
  ready: '就绪',
  error: '加载失败',
};

export function LoadingScreen({ stage, progress, done }: Props) {
  const [minElapsed, setMinElapsed] = useState(false);

  // 至少显示 1.1 秒，避免闪一下就消失（视觉上反而像卡顿）
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), 1100);
    return () => clearTimeout(t);
  }, []);

  const isError = stage.stage === 'error';
  const label = isError
    ? stage.message
    : STAGE_TEXT[stage.stage] ?? '载入中';

  return (
    <div className="loader" data-done={done && minElapsed}>
      <div className="loader-inner">
        <div className="loader-orbit">
          <div className="ring" />
          <div className="ring" />
          <div className="ring" />
          <div className="core" />
        </div>

        <h2 className="loader-title">AeroFlow Sky</h2>
        <p className="loader-sub">全球高空急流 · 跨洋航线借风推演</p>

        <div className="loader-bar">
          <div
            className="loader-bar-fill"
            style={{ width: `${Math.max(4, Math.min(100, progress * 100))}%` }}
          />
        </div>
        <div className="loader-stage">
          {label}
          {!isError && progress > 0 && progress < 1 ? ` · ${Math.round(progress * 100)}%` : ''}
        </div>

        {isError && (
          <div
            style={{
              marginTop: 16,
              fontSize: 10.5,
              color: 'var(--text-faint)',
              lineHeight: 1.8,
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(255,95,143,0.07)',
              border: '1px solid rgba(255,95,143,0.22)',
            }}
          >
            风场数据文件缺失或损坏。请先运行：
            <br />
            <code className="mono" style={{ color: 'var(--jet)' }}>
              python scripts/bake_wind.py
            </code>
            <br />
            <code className="mono" style={{ color: 'var(--jet)' }}>
              node scripts/bake_data.mjs
            </code>
          </div>
        )}
      </div>
    </div>
  );
}
