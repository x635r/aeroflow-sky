/**
 * 设备能力分级
 * ---------------------------------------------------------------------------
 * 用 UA 判断移动端是常见但不可靠的做法：
 *   · iPadOS 13+ 默认上报桌面版 Safari 的 UA
 *   · Android 平板、折叠屏、ChromeOS 设备形态跨度极大
 *   · 桌面浏览器窗口可能只有 500px 宽
 *
 * 这里按「实际渲染负担」分级：屏幕尺寸 × 设备像素比 × 是否触控。
 * 它决定粒子数、拖尾缓冲尺寸与像素比上限。
 */

export type DeviceTier = 'low' | 'medium' | 'high';

export type DeviceProfile = {
  tier: DeviceTier;
  /** 是否触控优先设备（用于交互容差与布局范式） */
  touch: boolean;
  /** 是否为窄屏（决定用抽屉布局） */
  narrow: boolean;
  /** 粒子状态纹理边长 */
  particleSize: number;
  /** 拖尾缓冲宽度 */
  trailWidth: number;
  /** 渲染像素比上限 */
  pixelRatio: number;
  /** 是否绘制大气辉光与星空（低端设备可省） */
  decorativeLayers: boolean;
};

/** 估算逻辑：以 CSS 像素面积 × dpr² 作为 GPU 负担的代理指标 */
export function detectDevice(): DeviceProfile {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  const touch =
    typeof window !== 'undefined' &&
    (window.matchMedia('(hover: none) and (pointer: coarse)').matches ||
      navigator.maxTouchPoints > 1);

  // 「用抽屉布局」的判据：窄屏 **或** 触控优先设备。
  // 只看宽度会漏掉 iPad 竖屏（768）与横屏手机（844）——
  // 这些设备握着用手指操作，但宽度超过 760，会落进桌面布局，
  // 而桌面那 7 个固定面板在 768 宽上必然互相挤压。
  const narrow = w <= 760 || (touch && w <= 1024);

  // 有效像素总量（百万像素）。桌面 1920×1080@2x ≈ 8.3MP
  const mp = (w * h * dpr * dpr) / 1e6;

  let tier: DeviceTier;
  if (mp < 2.2 || w < 420) {
    tier = 'low';
  } else if (mp < 5.5 || narrow || touch) {
    tier = 'medium';
  } else {
    tier = 'high';
  }

  const byTier: Record<DeviceTier, Omit<DeviceProfile, 'tier' | 'touch' | 'narrow'>> = {
    low: { particleSize: 192, trailWidth: 1024, pixelRatio: 1.25, decorativeLayers: false },
    medium: { particleSize: 256, trailWidth: 2048, pixelRatio: 1.5, decorativeLayers: true },
    high: { particleSize: 512, trailWidth: 4096, pixelRatio: 2, decorativeLayers: true },
  };

  return { tier, touch, narrow, ...byTier[tier] };
}
