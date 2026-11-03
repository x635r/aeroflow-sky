import { useEffect, useRef, useState } from 'react';

/**
 * 移动端面板容器
 * ---------------------------------------------------------------------------
 * 桌面端是把 7 个面板绝对定位在屏幕四角，这对手机完全不适用：
 * 375×667 的屏幕上，固定 316px 宽的面板会互相堆叠，
 * 之前用 `display:none` 把它们藏起来的结果是——核心功能直接消失
 * （推演结果、航班列表、湍流预警、测距全部不可达）。
 *
 * 移动端改用底部抽屉 + 标签页：
 *   · 抽屉收起时只留一行标签栏，地球占满屏幕
 *   · 上滑展开，切换标签查看不同面板
 *   · 拖动手柄或点标签切换，一处只显示一个面板，互不遮挡
 */

export type MobileTab = 'route' | 'result' | 'flights' | 'weather';

const TABS_HEIGHT = '46px';

export const MOBILE_TABS: Array<{ id: MobileTab; label: string; short: string }> = [
  { id: 'route', label: '航线', short: '航线' },
  { id: 'result', label: '推演结果', short: '结果' },
  { id: 'flights', label: '实时航班', short: '航班' },
  { id: 'weather', label: '气象与湍流', short: '气象' },
];

type Props = {
  active: MobileTab;
  onChange: (t: MobileTab) => void;
  children: React.ReactNode;
};

/** 在窄屏下生效的抽屉壳；宽屏下不渲染（由 CSS 隐藏） */
export function MobileSheet({ active, onChange, children }: Props) {
  // 初始展开：手机上第一眼就该看到面板内容。
  // 早期初始化为 false，用户只会看到一个空标签栏，不知道可以点。
  const [expanded, setExpanded] = useState(true);
  const touchStartY = useRef<number | null>(null);

  // 切到某个标签时自动展开，否则用户点了标签却看不到内容
  useEffect(() => {
    setExpanded(true);
  }, [active]);

  // 把展开状态与抽屉真实高度写到根节点。
  //
  // 高度必须在 JS 里算：CSS 的 62vh / 62dvh 在不同 WebView 里求值不一致
  // （实测内嵌浏览器里 62dvh 只给出 240px，而视口是 844px）。
  // 用 innerHeight 直接算再写成 CSS 变量，所有环境都一致。
  useEffect(() => {
    const app = document.querySelector('.app') as HTMLElement | null;
    if (!app) return;

    const apply = () => {
      const h = window.innerHeight;
      // 展开高度：62% 视口，下限 240（矮屏也要能看内容），上限 520。
      // 这个值与 CSS 里 timebar 的 bottom 必须一致，否则时间轴会被抽屉盖住
      // ——早期 clamp 到 480 而内联 height 用 523，就出现了遮挡。
      const sheetH = Math.max(240, Math.min(560, Math.round(h * 0.66)));
      app.style.setProperty('--sheet-h', `${sheetH}px`);
      app.setAttribute('data-sheet-open', String(expanded));

      // 同时写到元素内联样式。
      // 只靠 CSS 变量在这里不可靠：实测 .msheet[data-expanded] 的
      // height: var(--sheet-h) 规则 matches=true 且变量能解析，但
      // getComputedStyle 仍报 46px（flex 容器的 height 计算被 flex-basis
      // 干扰）。内联样式优先级最高，能确保结果确定。
      const el = document.querySelector('.msheet') as HTMLElement | null;
      if (el) el.style.height = expanded ? `${sheetH}px` : TABS_HEIGHT;
    };

    apply();
    // 首次挂载时 .msheet 可能还没渲染，下一帧再补一次
    const raf = requestAnimationFrame(apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, [expanded]);

  return (
    <div className="msheet" data-expanded={expanded}>
      <button
        className="msheet-handle"
        onClick={() => setExpanded((v) => !v)}
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? '收起面板' : '展开面板'}
        onTouchStart={(e) => {
          touchStartY.current = e.touches[0].clientY;
        }}
        onTouchEnd={(e) => {
          const start = touchStartY.current;
          if (start == null) return;
          const dy = e.changedTouches[0].clientY - start;
          touchStartY.current = null;
          // 上滑展开，下滑收起；阈值 24px 以区分点击与滑动
          if (dy < -24) setExpanded(true);
          else if (dy > 24) setExpanded(false);
        }}
      >
        <span className="msheet-grip" />
      </button>

      <div className="msheet-tabs" role="tablist">
        {MOBILE_TABS.map((t) => (
          <button
            key={t.id}
            className="msheet-tab"
            data-active={active === t.id}
            onClick={() => onChange(t.id)}
            type="button"
            role="tab"
            aria-selected={active === t.id}
          >
            {t.short}
          </button>
        ))}
      </div>

      <div className="msheet-body">{children}</div>
    </div>
  );
}
