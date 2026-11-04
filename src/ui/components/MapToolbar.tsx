import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';

/**
 * 地图工具条
 * ---------------------------------------------------------------------------
 * FR24 右侧那一竖排按钮：复位视角 / 全屏 / 罗盘。
 *
 * 都有一个共同点：它们是**地图控制**而不是数据面板，
 * 所以做成常驻的窄条，不占内容空间。
 */

export function MapToolbar({
  onReset,
  cameraHeading,
}: {
  onReset: () => void;
  /** 相机方位角（度），用于罗盘指针 */
  cameraHeading: number;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // 某些环境（iframe / 权限策略）不允许全屏，静默失败即可
    }
  };

  return (
    <div className="map-toolbar">
      {/* 罗盘：指针跟随相机方位 */}
      <button className="mt-btn mt-compass" type="button" title="相机朝向" tabIndex={-1} aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="rgba(120,190,230,0.25)" strokeWidth="1" />
          <g transform={`rotate(${cameraHeading} 12 12)`}>
            <path d="M12 4.5l2.6 7.5h-5.2z" fill="#ff5f8f" />
            <path d="M12 19.5l-2.6-7.5h5.2z" fill="rgba(120,190,230,0.5)" />
          </g>
          <circle cx="12" cy="12" r="1.4" fill="rgba(200,240,255,0.9)" />
        </svg>
      </button>

      <button className="mt-btn" onClick={onReset} type="button" title="复位视角 (R)" aria-label="复位视角">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3 12h18" />
        </svg>
      </button>

      <button
        className="mt-btn"
        onClick={toggleFullscreen}
        type="button"
        title={isFullscreen ? '退出全屏' : '全屏'}
        aria-label={isFullscreen ? '退出全屏' : '全屏'}
      >
        {isFullscreen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 3H3v6M15 21h6v-6M3 15v6h6M21 9V3h-6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 9V3h6M21 15v6h-6M15 3h6v6M9 21H3v-6" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </div>
  );
}

/**
 * 高度色标
 * ---------------------------------------------------------------------------
 * 飞机图标按高度着色，但没有图例的话用户根本不知道颜色含义。
 * 这个图例与 aircraftLayer 的 ALTITUDE_BANDS 必须同源——
 * 这里直接引用同一份常量，避免"图上黄色、图例说蓝色"。
 */
export function AltitudeLegend() {
  const snap = useStore((s) => s.liveSnapshot);
  const flights = snap?.flights ?? [];

  // 按高度带统计，图例上直接显示每档有多少架
  const counts = new Map<string, number>();
  for (const f of flights) {
    const alt = f.altitudeM;
    const id =
      alt < 1000 ? 'a' : alt < 3000 ? 'b' : alt < 7000 ? 'c' : alt < 10000 ? 'd' : alt < 12000 ? 'e' : 'f';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const bands = [
    { id: 'a', label: '地面', color: '#f05148' },
    { id: 'b', label: '低空', color: '#fa9e3d' },
    { id: 'c', label: '爬升', color: '#f5d95a' },
    { id: 'd', label: '中高', color: '#73e6b8' },
    { id: 'e', label: '巡航', color: '#6bccf5' },
    { id: 'f', label: '高空', color: '#9e9eff' },
  ];

  return (
    <div className="alt-legend">
      <span className="caps" style={{ fontSize: 8.5 }}>高度</span>
      <div className="alt-legend-row">
        {bands.map((b) => (
          <span key={b.id} className="alt-legend-item" title={`${b.label}：${counts.get(b.id) ?? 0} 架`}>
            <i style={{ background: b.color }} />
            <span className="mono">{counts.get(b.id) ?? 0}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
