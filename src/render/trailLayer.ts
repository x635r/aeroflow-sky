/**
 * 航班尾迹
 * ---------------------------------------------------------------------------
 * 每次轮询拿到新的航班位置时，把上一次的位置推进历史缓冲，
 * 用 LineSegments 把历史点连成轨迹。
 *
 * 关键约束：ADS-B 的轮询间隔是分钟级，所以尾迹天然是稀疏折线，
 * 不是平滑曲线。这里不做插值伪造——画出来的每一段都是真实观测位置，
 * 中间的空档如实反映"我们没观测到"。
 *
 * 为什么不给全部 4000 架都存尾迹：内存与带宽都会爆。只给用户
 * 选中/关注的那几架保留历史。
 */

import * as THREE from 'three';
import { toVec3 } from '../core/geo';
import type { LiveFlight } from '../data/liveFlights';

/** 单条尾迹最多保留的点数（每分钟一次轮询 ≈ 2 小时） */
const MAX_TRAIL_POINTS = 120;
/** 单点尾迹在球面上的抬升，避免与地表 z-fighting */
const TRAIL_RADIUS = 1.011;

type TrailRecord = {
  callsign: string;
  /** 经纬度历史，最新在末尾 */
  points: Array<{ lat: number; lon: number; alt: number }>;
  color: [number, number, number];
};

export type TrailLayer = {
  group: THREE.Group;
  /** 每次拿到新快照时调用，累积历史 */
  push: (flights: LiveFlight[], tracked: string[]) => void;
  /** 清空所有历史（切换数据源时用） */
  clear: () => void;
  setVisible: (v: boolean) => void;
  dispose: () => void;
};

export function createTrailLayer(): TrailLayer {
  const group = new THREE.Group();
  group.name = 'trail-layer';

  const trails = new Map<string, TrailRecord>();

  // 用一个大 BufferGeometry 容纳所有尾迹线段，避免每架飞机一个 draw call
  let geometry = new THREE.BufferGeometry();
  let lineSegments = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    }),
  );
  lineSegments.frustumCulled = false;
  lineSegments.renderOrder = 3;
  group.add(lineSegments);

  /** 重建线段几何体 */
  const rebuild = () => {
    const positions: number[] = [];
    const colors: number[] = [];

    for (const rec of trails.values()) {
      const pts = rec.points;
      if (pts.length < 2) continue;

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const va = toVec3(a.lat, a.lon, TRAIL_RADIUS);
        const vb = toVec3(b.lat, b.lon, TRAIL_RADIUS);
        positions.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);

        // 越旧越淡：用颜色明度编码时间
        const t0 = i / (pts.length - 1);
        const t1 = (i + 1) / (pts.length - 1);
        const fade0 = 0.15 + t0 * 0.85;
        const fade1 = 0.15 + t1 * 0.85;
        colors.push(
          rec.color[0] * fade0,
          rec.color[1] * fade0,
          rec.color[2] * fade0,
          rec.color[0] * fade1,
          rec.color[1] * fade1,
          rec.color[2] * fade1,
        );
      }
    }

    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    newGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    lineSegments.geometry.dispose();
    lineSegments.geometry = newGeo;
    geometry = newGeo;
  };

  return {
    group,

    push(flights: LiveFlight[], tracked: string[]) {
      const wanted = new Set(tracked);
      const seen = new Set<string>();

      for (const f of flights) {
        if (!wanted.has(f.callsign)) continue;
        seen.add(f.callsign);

        let rec = trails.get(f.callsign);
        if (!rec) {
          rec = {
            callsign: f.callsign,
            points: [],
            color: [0.42, 0.80, 0.96],
          };
          trails.set(f.callsign, rec);
        }

        // 只有位置确实移动了才追加，避免重复点把线段叠成 0 长度
        const last = rec.points[rec.points.length - 1];
        const moved =
          !last ||
          Math.abs(last.lat - f.lat) > 0.001 ||
          Math.abs(last.lon - f.lon) > 0.001;
        if (moved) {
          rec.points.push({ lat: f.lat, lon: f.lon, alt: f.altitudeM });
          if (rec.points.length > MAX_TRAIL_POINTS) rec.points.shift();
        }
      }

      // 不再关注的航班清掉历史，避免无限增长
      for (const key of [...trails.keys()]) {
        if (!seen.has(key) && !wanted.has(key)) trails.delete(key);
      }

      rebuild();
    },

    clear() {
      trails.clear();
      rebuild();
    },

    setVisible(v: boolean) {
      group.visible = v;
    },

    dispose() {
      trails.clear();
      geometry.dispose();
      (lineSegments.material as THREE.Material).dispose();
    },
  };
}
