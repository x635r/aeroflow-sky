/**
 * 海岸线纹理生成
 * ---------------------------------------------------------------------------
 * 在离屏 Canvas 上把 Natural Earth 多边形栅格化成等距圆柱投影纹理，
 * 陆地用低饱和钢蓝填充，海岸用冷白描边，供地球球面采样。
 *
 * 这样做的原因：矢量线段在球面上做抗锯齿代价高，而 4096×2048 的纹理
 * 一次生成后每帧只是一次采样，且能直接当作地形遮罩与粒子底层使用。
 */

export type LandPolygon = number[][][];

export type LandTextureOptions = {
  width?: number;
  height?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** 是否绘制经纬网格 */
  graticule?: boolean;
  graticuleColor?: string;
  graticuleStep?: number;
  background?: string;
};

export function rasterizeLand(
  polygons: LandPolygon[],
  opts: LandTextureOptions = {},
): HTMLCanvasElement {
  const {
    width = 4096,
    height = 2048,
    fill = 'rgba(255,255,255,1)',
    stroke = 'rgba(255, 255, 255, 1)',
    strokeWidth = 0.9,
    graticule = true,
    graticuleColor = 'rgba(90, 150, 200, 0.09)',
    graticuleStep = 15,
    background = 'rgba(0,0,0,0)',
  } = opts;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // alpha: true —— 透明区即海洋，着色器用 alpha 当陆地遮罩
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return canvas;

  const projX = (lon: number) => ((lon + 180) / 360) * width;
  const projY = (lat: number) => ((90 - lat) / 180) * height;

  if (background !== 'rgba(0,0,0,0)') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  if (graticule) {
    ctx.strokeStyle = graticuleColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += graticuleStep) {
      const x = projX(lon);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let lat = -75; lat <= 75; lat += graticuleStep) {
      const y = projY(lat);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  /**
   * 把一条经纬环拆成若干「不跨 180° 经线」的子环。
   *
   * 等距圆柱投影下，跨日界线的多边形会从图最右直接连回最左，
   * 画出来就是横贯整张图的一条错误长边。按经度跳变切开后，
   * 每段都是合法的连续折线。
   */
  const splitAtAntimeridian = (ring: number[][]): number[][][] => {
    const parts: number[][][] = [];
    let cur: number[][] = [];
    let prevLon: number | null = null;
    for (const pt of ring) {
      const lon = pt[0];
      if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
        if (cur.length >= 3) parts.push(cur);
        cur = [];
      }
      cur.push(pt);
      prevLon = lon;
    }
    if (cur.length >= 3) parts.push(cur);
    return parts;
  };

  /** 把一个子环追加进当前路径（不调用 beginPath）。ring 是点数组。 */
  const appendRing = (ring: number[][], shift: number) => {
    if (ring.length < 3) return;
    const [lon0, lat0] = ring[0];
    ctx.moveTo(projX(lon0) + shift, projY(lat0));
    for (let i = 1; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      ctx.lineTo(projX(lon) + shift, projY(lat));
    }
    ctx.closePath();
  };

  /** 遍历多边形，把它的所有子环都追加到当前路径，并按需在 0/360 处镜像一份 */
  const appendPolygon = (poly: LandPolygon) => {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const pt of ring) {
        if (pt[0] < minLon) minLon = pt[0];
        if (pt[0] > maxLon) maxLon = pt[0];
      }
      const spansDateline = maxLon - minLon > 300;
      for (const part of splitAtAntimeridian(ring)) {
        appendRing(part, 0);
        // 跨日界线或贴边（如南极）的多边形需要一份经度 +360 的副本，
        // 否则右边缘会出现一条竖缝
        if (spansDateline || minLon < -175) appendRing(part, width);
      }
    }
  };

  // 关键：所有环必须落在【同一条路径】里再一次性 fill()。
  // 若每个环都单独 beginPath + fill，画布只会留下最后一个环，
  // 结果是「只有海岸线、大陆内部全空」。
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (const poly of polygons) appendPolygon(poly);
  ctx.fill('evenodd');

  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const poly of polygons) appendPolygon(poly);
  ctx.stroke();

  return canvas;
}
