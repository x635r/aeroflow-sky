/**
 * 全球机场图层
 * ---------------------------------------------------------------------------
 * 用单次 InstancedMesh 画 500+ 个机场点：一个 draw call，不需要每个机场
 * 建一个 Object3D。点的屏幕尺寸随相机距离自适应，近看是大圆点，
 * 远看是小亮点，不会在缩放时糊成一片或消失。
 *
 * 枢纽机场（按航班连接度）额外画一圈光晕，让"世界航空骨架"一眼可见。
 */

import * as THREE from 'three';
import { toVec3 } from '../core/geo';
import type { Airport } from '../state/store';

export type AirportLayerOptions = {
  /** 球面半径，略高于地表避免 z-fighting */
  radius?: number;
  /** 显示为「枢纽」的机场数量（按 degree 排序） */
  hubCount?: number;
  color?: number;
  hubColor?: number;
};

export type AirportLayer = {
  /** 挂在场景里的对象（含点与光晕两层） */
  group: THREE.Group;
  /** 由 GlobeScene 每帧调用，传入相机距离用于自适应点大小 */
  update: (cameraDistance: number) => void;
  setVisible: (v: boolean) => void;
  /** 高亮某个机场（IATA），null 取消高亮 */
  setHighlight: (iata: string | null) => void;
  /** 屏幕空间拾取：返回最近的机场 */
  pick: (
    normalizedX: number,
    normalizedY: number,
    camera: THREE.Camera,
    viewportHeight?: number,
  ) => Airport | null;
  dispose: () => void;
};

export function createAirportLayer(
  airports: Airport[],
  opts: AirportLayerOptions = {},
): AirportLayer {
  const radius = opts.radius ?? 1.003;
  const hubCount = opts.hubCount ?? 42;

  const group = new THREE.Group();
  group.name = 'airport-layer';

  // 按连接度排序，前 hubCount 个视为枢纽
  const sorted = [...airports].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  const hubSet = new Set(sorted.slice(0, hubCount).map((a) => a.iata));

  const n = airports.length;
  if (n === 0) {
    return {
      group,
      update: () => {},
      setVisible: () => {},
      setHighlight: () => {},
      pick: () => null,
      dispose: () => {},
    };
  }

  // ---- 普通机场点 ----
  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const isHub = new Float32Array(n);
  const idxByIata = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const a = airports[i];
    const v = toVec3(a.lat, a.lon, radius);
    positions[i * 3] = v[0];
    positions[i * 3 + 1] = v[1];
    positions[i * 3 + 2] = v[2];
    const hub = hubSet.has(a.iata);
    isHub[i] = hub ? 1 : 0;
    sizes[i] = hub ? 1 : 0.55;
    idxByIata.set(a.iata, i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aHub', new THREE.BufferAttribute(isHub, 1));
  // 每个点的调色（枢纽更亮）
  // 高亮用显式索引属性，Points 里没有 gl_VertexID
  const indexArr = new Float32Array(n);
  for (let i = 0; i < n; i++) indexArr[i] = i;
  geo.setAttribute('aIndex', new THREE.BufferAttribute(indexArr, 1));

  const uniforms = {
    uCameraDist: { value: 3 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uColor: { value: new THREE.Color(opts.color ?? 0x9fe8ff) },
    uHubColor: { value: new THREE.Color(opts.hubColor ?? 0xffd166) },
    uHighlight: { value: -1 },
    uOpacity: { value: 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aHub;
      attribute float aIndex;
      uniform float uCameraDist;
      uniform float uPixelRatio;
      uniform float uHighlight;
      varying float vHub;
      varying float vHighlight;

      void main() {
        vHub = aHub;
        vHighlight = abs(aIndex - uHighlight) < 0.5 ? 1.0 : 0.0;

        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;

        // 距离越远点越小；下限保证缩放后仍可见
        float d = clamp(uCameraDist, 1.2, 8.0);
        float base = mix(2.2, 0.9, smoothstep(1.3, 6.0, d));
        gl_PointSize = base * (0.85 + aSize) * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uHubColor;
      uniform float uOpacity;
      varying float vHub;
      varying float vHighlight;

      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;

        float core = smoothstep(0.5, 0.12, r);
        vec3 col = mix(uColor, uHubColor, vHub);
        // 枢纽加一圈柔光
        float halo = vHub * smoothstep(0.5, 0.28, r) * 0.7;
        float a = (core + halo) * uOpacity;

        // 高亮：变白并放大
        col = mix(col, vec3(1.0), vHighlight * 0.75);
        a *= 1.0 + vHighlight * 0.6;

        if (a < 0.01) discard;
        gl_FragColor = vec4(col * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  group.add(points);

  // ---- 光晕层：只给枢纽画一圈环 ----
  const hubs = sorted.slice(0, hubCount);
  const ringGeo = new THREE.BufferGeometry();
  const ringPos = new Float32Array(hubs.length * 3);
  for (let i = 0; i < hubs.length; i++) {
    const v = toVec3(hubs[i].lat, hubs[i].lon, radius * 1.0005);
    ringPos[i * 3] = v[0];
    ringPos[i * 3 + 1] = v[1];
    ringPos[i * 3 + 2] = v[2];
  }
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));

  const ringMat = new THREE.ShaderMaterial({
    uniforms: {
      uCameraDist: uniforms.uCameraDist,
      uPixelRatio: uniforms.uPixelRatio,
      uColor: { value: new THREE.Color(opts.hubColor ?? 0xffd166) },
    },
    vertexShader: /* glsl */ `
      uniform float uCameraDist;
      uniform float uPixelRatio;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = clamp(uCameraDist, 1.2, 8.0);
        gl_PointSize = mix(9.0, 3.6, smoothstep(1.3, 6.0, d)) * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        // 只画环，中心留空
        float ring = smoothstep(0.62, 0.72, r) * smoothstep(0.95, 0.82, r);
        float a = ring * 0.45;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });

  const rings = new THREE.Points(ringGeo, ringMat);
  rings.frustumCulled = false;
  rings.renderOrder = 2;
  group.add(rings);

  // 用 Raycaster 在屏幕空间做拾取。点云拾取需要自定义阈值，
  // 所以这里不用 Raycaster.intersectObject，而是手算投影距离。
  const projected = new THREE.Vector3();

  return {
    group,
    update(cameraDistance: number) {
      uniforms.uCameraDist.value = cameraDistance;
    },
    setVisible(v: boolean) {
      group.visible = v;
    },
    setHighlight(iata: string | null) {
      const idx = iata != null ? idxByIata.get(iata) : undefined;
      uniforms.uHighlight.value = idx ?? -1;
    },
    /**
     * 屏幕空间拾取。
     *
     * 阈值必须按**像素**给而不是写死一个 NDC 常数：NDC 全宽是 2，
     * 0.0022 NDC 在 1920px 画布上只有约 2 像素——而渲染出来的点本身就有
     * 2–3 像素，于是用户几乎永远点不中机场，每次都落到「吸附最近机场」
     * 分支，把几千公里外的机场静默设成目的地。
     */
    pick(nx: number, ny: number, camera: THREE.Camera, viewportHeight = 900): Airport | null {
      let best = -1;
      // 12 像素的容差，折算成 NDC
      const pixelTol = 12;
      let bestD = (pixelTol / viewportHeight) * 2;
      let bestDepth = Infinity;

      for (let i = 0; i < n; i++) {
        projected.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        // 背面剔除：与相机方向的点积
        const toCam = camera.position.clone().sub(projected).normalize();
        const outward = projected.clone().normalize();
        if (toCam.dot(outward) <= 0.02) continue;

        projected.project(camera);
        if (projected.z > 1) continue;
        const dx = projected.x - nx;
        const dy = projected.y - ny;
        const d = Math.hypot(dx, dy);
        // 枢纽更容易被点中
        const weight = isHub[i] > 0.5 ? 1 : 1.6;
        if (d * weight < bestD) {
          bestD = d * weight;
          best = i;
          bestDepth = projected.z;
        }
      }
      void bestDepth;
      return best >= 0 ? airports[best] : null;
    },
    dispose() {
      geo.dispose();
      ringGeo.dispose();
      material.dispose();
      ringMat.dispose();
    },
  };
}
