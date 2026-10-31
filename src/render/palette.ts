/**
 * 视觉语言：风速色阶 / CAT 色阶 / 航班类别色
 * ---------------------------------------------------------------------------
 * colorRamp 在 GPU 与 Canvas 之间共享同一组控制点，保证 UI 图例
 * 与画面里的粒子颜色严格一致——这是「数据可信」的视觉前提。
 */

export type RampStop = { t: number; color: [number, number, number] };

/** 风速色阶（m/s → RGB 0..1）。低饱和青 → 青蓝 → 白热 → 品红，突出急流核心。 */
export const WIND_RAMP: RampStop[] = [
  { t: 0.0, color: [0.09, 0.16, 0.28] },
  { t: 0.16, color: [0.11, 0.34, 0.55] },
  { t: 0.34, color: [0.13, 0.58, 0.79] },
  { t: 0.52, color: [0.32, 0.82, 0.86] },
  { t: 0.68, color: [0.72, 0.94, 0.86] },
  { t: 0.82, color: [1.0, 0.92, 0.62] },
  { t: 0.92, color: [1.0, 0.55, 0.34] },
  { t: 1.0, color: [1.0, 0.32, 0.62] },
];

/** CAT 湍流色阶：透明 → 琥珀 → 橙红 → 洋红 */
export const CAT_RAMP: RampStop[] = [
  { t: 0.0, color: [0.1, 0.5, 0.6] },
  { t: 0.35, color: [0.95, 0.78, 0.25] },
  { t: 0.62, color: [0.98, 0.45, 0.16] },
  { t: 0.85, color: [0.92, 0.18, 0.42] },
  { t: 1.0, color: [0.85, 0.1, 0.75] },
];

export const CATEGORY_COLORS: Record<string, string> = {
  widebody: '#5ee7c4',
  narrowbody: '#7fb8ff',
  regional: '#c8a6ff',
  cargo: '#ffb35c',
};

/** 把色阶展开成 canvas 渐变用的 CSS 字符串 */
export function rampToCss(ramp: RampStop[], alpha = 1): string {
  const stops = ramp
    .map((s) => {
      const [r, g, b] = s.color;
      const c = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
      return `${c} ${(s.t * 100).toFixed(1)}%`;
    })
    .join(', ');
  return `linear-gradient(90deg, ${stops})`;
}

/** CPU 端采样色阶（用于图例数值、CAT 条、导出图片） */
export function sampleRamp(ramp: RampStop[], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i];
    const b = ramp[i + 1];
    if (x >= a.t && x <= b.t) {
      const k = (x - a.t) / (b.t - a.t || 1);
      return [
        a.color[0] + (b.color[0] - a.color[0]) * k,
        a.color[1] + (b.color[1] - a.color[1]) * k,
        a.color[2] + (b.color[2] - a.color[2]) * k,
      ];
    }
  }
  return ramp[ramp.length - 1].color;
}

export function toCss(rgb: [number, number, number], alpha = 1): string {
  return `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${alpha})`;
}

/** 生成 GLSL 色阶函数（编译期常量，避免 uniform 数组开销） */
export function rampToGLSL(name: string, ramp: RampStop[]): string {
  const lines = ramp.map((s) => `  if (t <= ${s.t.toFixed(4)}) {`);
  let out = `vec3 ${name}(float t) {\n  t = clamp(t, 0.0, 1.0);\n`;
  let prev = ramp[0];
  out += `  if (t <= ${ramp[0].t.toFixed(4)}) return vec3(${ramp[0].color.map((c) => c.toFixed(4)).join(', ')});\n`;
  for (let i = 1; i < ramp.length; i++) {
    const a = prev;
    const b = ramp[i];
    void a;
    out += `  if (t <= ${b.t.toFixed(4)}) {\n`;
    out += `    float k = (t - ${ramp[i - 1].t.toFixed(4)}) / ${(b.t - ramp[i - 1].t).toFixed(4)};\n`;
    out += `    return mix(vec3(${ramp[i - 1].color.map((c) => c.toFixed(4)).join(', ')}), vec3(${b.color.map((c) => c.toFixed(4)).join(', ')}), k);\n`;
    out += '  }\n';
    prev = b;
  }
  out += `  return vec3(${ramp[ramp.length - 1].color.map((c) => c.toFixed(4)).join(', ')});\n}`;
  void lines;
  return out;
}

/** 色阶 → 1D LUT 纹理，供着色器采样（更省 ALU 且便于动态调整） */
export function rampToLUT(ramp: RampStop[], size = 256): Uint8Array {
  const lut = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = sampleRamp(ramp, i / (size - 1));
    lut[i * 4] = Math.round(r * 255);
    lut[i * 4 + 1] = Math.round(g * 255);
    lut[i * 4 + 2] = Math.round(b * 255);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
