/**
 * 航线渲染
 * ---------------------------------------------------------------------------
 * 三种航线用不同的视觉语言区分，且都能读出数据：
 *
 *   大圆          —— 细虚线，冷灰，作为「理论最短」的参考基准
 *   借风最优      —— 实线 + 发光，颜色随顺风分量由冷转暖（越顺风越亮）
 *   恒向线        —— 更暗的点线，只做对照
 *
 * 湍流段用红黄渐变的加粗管状体标出，直接贴合「三维航路上的颠簸区」。
 */

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { toVec3, type LatLon } from '../core/geo';
import { CAT_AFFECTED_THRESHOLD, type RouteResult, type RoutePoint } from '../sim/routeEngine';

const ROUTE_RADIUS = 1.006;
const CAT_RADIUS = 1.012;

function toPositions(points: Array<LatLon | RoutePoint>, radius: number, altScale = 0): number[] {
  const out: number[] = [];
  for (const p of points) {
    const lift = radius + altScale;
    const v = toVec3(p.lat, p.lon, lift);
    out.push(v[0], v[1], v[2]);
  }
  return out;
}

export type RouteVisuals = {
  group: THREE.Group;
  setResolution: (w: number, h: number) => void;
  setVisible: (v: boolean) => void;
  setOpacity: (o: number) => void;
  dispose: () => void;
};

export function createRouteLine(
  result: RouteResult,
  style: 'optimal' | 'greatcircle' | 'rhumb',
  resolution: { w: number; h: number },
): RouteVisuals {
  const group = new THREE.Group();
  group.name = `route-${style}`;

  const materials: LineMaterial[] = [];
  const geometries: LineGeometry[] = [];

  const makeLine = (
    coords: Array<LatLon | RoutePoint>,
    opts: {
      color: number;
      width: number;
      opacity: number;
      dashed?: boolean;
      dashSize?: number;
      gapSize?: number;
      radius?: number;
      vertexColors?: number[];
    },
  ) => {
    const geo = new LineGeometry();
    const pos = toPositions(coords, opts.radius ?? ROUTE_RADIUS);
    geo.setPositions(pos);
    if (opts.vertexColors) geo.setColors(opts.vertexColors);

    const mat = new LineMaterial({
      color: opts.color,
      linewidth: opts.width,
      resolution: new THREE.Vector2(resolution.w, resolution.h),
      transparent: true,
      opacity: opts.opacity,
      dashed: opts.dashed ?? false,
      dashSize: opts.dashSize ?? 0.012,
      gapSize: opts.gapSize ?? 0.008,
      worldUnits: false,
      vertexColors: !!opts.vertexColors,
      depthWrite: false,
      depthTest: true,
    });
    if (opts.dashed) mat.defines = { ...(mat.defines ?? {}), USE_DASH: '' };

    const line = new Line2(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 3;
    materials.push(mat);
    geometries.push(geo);
    group.add(line);
    return line;
  };

  if (style === 'optimal') {
    // 主线：按顺风分量着色，顺风段偏暖金，逆风段偏青
    const colors: number[] = [];
    for (const p of result.points) {
      const t = Math.max(0, Math.min(1, (p.windAlong + 40) / 100));
      const c = new THREE.Color().setHSL(
        THREE.MathUtils.lerp(0.52, 0.11, t),
        THREE.MathUtils.lerp(0.85, 0.95, t),
        THREE.MathUtils.lerp(0.58, 0.62, t),
      );
      colors.push(c.r, c.g, c.b);
    }
    makeLine(result.points, {
      color: 0xffffff,
      width: 3.4,
      opacity: 1,
      vertexColors: colors,
    });
    // 外发光：更宽更淡的第二条
    makeLine(result.points, { color: 0x39d3ff, width: 9, opacity: 0.09 });

    // 湍流段：红黄渐变加粗
    const catPoints = result.points.map((p) => ({ ...p }));
    const catColors: number[] = [];
    for (const p of catPoints) {
      const t = Math.max(0, Math.min(1, (p.cat - CAT_AFFECTED_THRESHOLD) / 0.6));
      const col = new THREE.Color().setHSL(
        THREE.MathUtils.lerp(0.14, 0.98, t),
        0.92,
        THREE.MathUtils.lerp(0.55, 0.6, t),
      );
      catColors.push(col.r, col.g, col.b);
    }
    const catLine = makeLine(catPoints, {
      color: 0xffffff,
      width: 6.5,
      opacity: 0.0,
      radius: CAT_RADIUS,
      vertexColors: catColors,
    });
    catLine.name = 'cat-overlay';
    // 用逐点透明度无法在 LineMaterial 里表达，改为整条线低透明 + 靠颜色突出
    (catLine.material as LineMaterial).opacity = 0.0;
  } else if (style === 'greatcircle') {
    makeLine(result.points, {
      color: 0x8fa8bd,
      width: 1.6,
      opacity: 0.55,
      dashed: true,
      dashSize: 0.008,
      gapSize: 0.011,
    });
  } else {
    makeLine(result.points, {
      color: 0x5a6b7d,
      width: 1.2,
      opacity: 0.32,
      dashed: true,
      dashSize: 0.004,
      gapSize: 0.014,
      radius: ROUTE_RADIUS - 0.001,
    });
  }

  return {
    group,
    setResolution(w: number, h: number) {
      for (const m of materials) m.resolution.set(w, h);
    },
    setVisible(v: boolean) {
      group.visible = v;
    },
    setOpacity(o: number) {
      for (const m of materials) {
        if (m.opacity > 0.01) m.opacity = Math.min(1, m.opacity * o + (o > 0 ? 0 : 0));
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

/**
 * 湍流管：把 CAT 高的航段做成可见的「热管」，半径随指数增长。
 * 用 CatmullRom 的 TubeGeometry，在球面上显得它是凸起于航路的。
 */
export function createTurbulenceTubes(
  points: RoutePoint[],
  threshold = CAT_AFFECTED_THRESHOLD,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'turbulence';

  // 切出连续的高 CAT 段
  const segments: RoutePoint[][] = [];
  let cur: RoutePoint[] = [];
  for (const p of points) {
    if (p.cat >= threshold) {
      cur.push(p);
    } else if (cur.length) {
      if (cur.length >= 2) segments.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) segments.push(cur);

  for (const seg of segments) {
    const pts = seg.map((p) => {
      const v = toVec3(p.lat, p.lon, CAT_RADIUS);
      return new THREE.Vector3(v[0], v[1], v[2]);
    });
    if (pts.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(pts);
    const peak = Math.max(...seg.map((p) => p.cat));
    const geo = new THREE.TubeGeometry(curve, Math.max(8, seg.length * 2), 0.0016 + peak * 0.0035, 6, false);
    const col = new THREE.Color().setHSL(
      THREE.MathUtils.lerp(0.13, 0.99, Math.min(1, (peak - threshold) / 0.5)),
      0.95,
      0.58,
    );
    const mat = new THREE.MeshBasicMaterial({
      color: col,
      transparent: true,
      opacity: 0.55 + peak * 0.35,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 4;
    group.add(mesh);
  }

  return group;
}

/** 起降机场标记：外圈脉冲环 + 中心点 */
export function createAirportMarker(lat: number, lon: number, color = 0x5ee7c4, radius = 1.004): THREE.Group {
  const group = new THREE.Group();
  const v = toVec3(lat, lon, radius);
  group.position.set(v[0], v[1], v[2]);
  group.lookAt(0, 0, 0);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.012, 0.019, 24),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.renderOrder = 5;
  group.add(ring);

  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.0075, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  dot.renderOrder = 6;
  group.add(dot);

  return group;
}

/** 沿航路运行的航班标记（用于"演示一架飞机正在飞"） */
export function createAircraftMarker(color = 0xffd166): THREE.Group {
  const group = new THREE.Group();
  group.name = 'aircraft-marker';

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.006, 12, 8),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
    }),
  );
  group.add(glow);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.014, 12, 8),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.16,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
    }),
  );
  group.add(halo);
  group.renderOrder = 7;
  return group;
}
