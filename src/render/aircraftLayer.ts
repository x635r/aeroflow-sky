/**
 * 飞机图层
 * ---------------------------------------------------------------------------
 * FR24 最核心的视觉元素：地球上一架架朝航向飞行的飞机图标。
 *
 * 实现要点：
 *   1. 单个 Points 绘制全部航班，一次 draw call。每架飞机的航向、高度、
 *      速度都通过顶点属性传入，由着色器决定朝向与颜色。
 *   2. 图标在屏幕空间旋转：点精灵（gl_PointCoord）以中心为轴按航向角旋转，
 *      因此无论相机怎么转，机头始终指向真实航迹方向。
 *   3. 按高度着色：低空暖色、巡航高度冷色，一眼能区分正在爬升的与巡航的。
 *   4. 点大小随相机距离自适应，避免缩远后糊成一片。
 */

import * as THREE from 'three';
import { toVec3 } from '../core/geo';
import type { LiveFlight } from '../data/liveFlights';

export type AircraftLayer = {
  group: THREE.Group;
  /** 用最新快照更新图标数据（会复用缓冲区，不重建几何体） */
  update: (flights: LiveFlight[]) => void;
  /** 每帧调用：随相机距离调整点大小 */
  setCameraDistance: (d: number) => void;
  setVisible: (v: boolean) => void;
  /** 高亮某架（按 callsign），null 取消 */
  setSelected: (callsign: string | null) => void;
  /** 屏幕空间拾取，返回命中航班的索引（-1 未命中） */
  pick: (nx: number, ny: number, camera: THREE.Camera, viewportHeight: number) => number;
  dispose: () => void;
};

/** 高度分带配色（米）。巡航高度用冷色，低空用暖色，落地附近偏红 */
export const ALTITUDE_BANDS: Array<{
  maxM: number;
  label: string;
  color: [number, number, number];
}> = [
  { maxM: 1000, label: '地面/进近', color: [0.95, 0.32, 0.28] },
  { maxM: 3000, label: '低空', color: [0.98, 0.62, 0.24] },
  { maxM: 7000, label: '爬升/下降', color: [0.96, 0.85, 0.35] },
  { maxM: 10000, label: '中高度', color: [0.45, 0.90, 0.72] },
  { maxM: 12000, label: '巡航', color: [0.42, 0.80, 0.96] },
  { maxM: Infinity, label: '高空巡航', color: [0.62, 0.62, 1.0] },
];

export function altitudeBandColor(altM: number): [number, number, number] {
  for (const band of ALTITUDE_BANDS) {
    if (altM <= band.maxM) return band.color;
  }
  return ALTITUDE_BANDS[ALTITUDE_BANDS.length - 1].color;
}

const MAX_AIRCRAFT = 4000;
const RADIUS = 1.012;

export function createAircraftLayer(): AircraftLayer {
  const group = new THREE.Group();
  group.name = 'aircraft-layer';

  // 位置、航向、高度、选中标记
  const positions = new Float32Array(MAX_AIRCRAFT * 3);
  const headings = new Float32Array(MAX_AIRCRAFT);
  const colors = new Float32Array(MAX_AIRCRAFT * 3);
  const selectedFlags = new Float32Array(MAX_AIRCRAFT);
  const indexAttr = new Float32Array(MAX_AIRCRAFT);
  for (let i = 0; i < MAX_AIRCRAFT; i++) indexAttr[i] = i;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aHeading', new THREE.BufferAttribute(headings, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSelected', new THREE.BufferAttribute(selectedFlags, 1));
  geo.setAttribute('aIndex', new THREE.BufferAttribute(indexAttr, 1));
  geo.setDrawRange(0, 0);

  const uniforms = {
    uCameraDist: { value: 3 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uBaseSize: { value: 30 },
    uTime: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aHeading;
      attribute vec3 aColor;
      attribute float aSelected;
      attribute float aIndex;

      uniform float uCameraDist;
      uniform float uPixelRatio;
      uniform float uBaseSize;
      uniform float uTime;

      varying vec3 vColor;
      varying float vHeading;
      varying float vSelected;
      varying float vFade;

      void main() {
        vColor = aColor;
        // 航迹角转成屏幕旋转角：0°=北(-Y)、90°=东(+X)
        vHeading = radians(aHeading);
        vSelected = aSelected;

        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;

        float d = clamp(uCameraDist, 1.2, 8.0);
        // 距离越远点越小；选中时放大
        float size = mix(uBaseSize, uBaseSize * 0.55, smoothstep(1.3, 6.5, d));
        size *= 1.0 + aSelected * 0.55;
        gl_PointSize = size * uPixelRatio;

        // 背面（被地球挡住）淡化：与相机方向的点积
        vec3 worldPos = position;
        vec3 toCam = normalize(cameraPosition - worldPos);
        float facing = dot(normalize(worldPos), toCam);
        vFade = smoothstep(-0.05, 0.18, facing);
        void(uTime);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying float vHeading;
      varying float vSelected;
      varying float vFade;

      // 把屏幕坐标绕中心旋转，使机头对准航向
      vec2 rotate(vec2 p, float a) {
        float c = cos(a), s = sin(a);
        return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
      }

      void main() {
        // 点精灵坐标 → [-1,1]，y 轴取反使"上"为正
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        p.y = -p.y;

        // 航向角：0 = 朝上（北），顺时针为正
        p = rotate(p, -vHeading);

        // 图标：小尺寸下"机身+主翼+尾翼"会糊成一团，
      // 用「三角箭头 + 后掠翼」的极简轮廓，任何尺寸都能认出朝向。
      //
      // 定义（p.y 向上为机头方向）：
      //   nose  —— 顶部三角
      //   wing  —— 中部的后掠横条
      //   body  —— 细长机身
      float nose = step(p.y, 0.52) * step(-0.10, p.y)
                 * step(abs(p.x), (0.52 - p.y) * 0.62);
      float body = step(abs(p.x), 0.085) * step(abs(p.y), 0.40);
      // 后掠翼：y 越靠后越宽
      float wingW = 0.14 + (0.30 - p.y) * 1.55;
      float wing = step(abs(p.y - 0.02), 0.085) * step(abs(p.x), wingW);

      float shape = max(nose, max(body, wing));

      // 描边（外扩一圈，深色）——急流粒子很亮，没有这层几乎看不见
      float noseO = step(p.y, 0.585) * step(-0.15, p.y)
                  * step(abs(p.x), (0.585 - p.y) * 0.70);
      float bodyO = step(abs(p.x), 0.135) * step(abs(p.y), 0.45);
      float wingWO = 0.19 + (0.30 - p.y) * 1.55;
      float wingO = step(abs(p.y - 0.02), 0.135) * step(abs(p.x), wingWO);
      float outline = max(noseO, max(bodyO, wingO));

      if (outline < 0.5) discard;

        vec3 col = vColor;
        float isCore = shape > 0.5;
        // 外圈用近黑，内芯用高度色
        if (isCore < 0.5) {
          col = vec3(0.02, 0.04, 0.06);
        }
        // 选中：加白边与光晕
        if (vSelected > 0.5) {
          float edge = 1.0 - smoothstep(0.30, 0.55, max(abs(p.x), abs(p.y)));
          col = mix(col, vec3(1.0), 0.35);
          col += vec3(0.5) * edge;
        }

        float alpha = vFade * mix(0.75, 1.0, isCore);
        alpha *= 0.88 + vSelected * 0.12;
        if (alpha < 0.01) discard;

        // 内芯提亮，让颜色在深色描边上跳出来
        if (isCore > 0.5) col *= 1.35;

        // 预乘 alpha 配 One/One 混合：颜色已乘 alpha，alpha 通道写 1.0。
        // 写成 vec4(col*alpha, alpha) 会让 alpha 也参与累加，
        // 在多层叠加时边缘会越叠越实，与项目其它图层的行为不一致。
        gl_FragColor = vec4(col * alpha, 1.0);
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
  points.renderOrder = 4;
  group.add(points);

  // 当前快照的航班列表，供拾取使用
  let current: LiveFlight[] = [];
  let selectedCallsign: string | null = null;

  return {
    group,

    update(flights: LiveFlight[]) {
      current = flights;
      const n = Math.min(flights.length, MAX_AIRCRAFT);

      for (let i = 0; i < n; i++) {
        const f = flights[i];
        const v = toVec3(f.lat, f.lon, RADIUS);
        positions[i * 3] = v[0];
        positions[i * 3 + 1] = v[1];
        positions[i * 3 + 2] = v[2];

        headings[i] = Number.isFinite(f.track) ? f.track : 0;

        const [r, g, b] = altitudeBandColor(f.altitudeM);
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;

        selectedFlags[i] = selectedCallsign && f.callsign === selectedCallsign ? 1 : 0;
      }

      geo.setDrawRange(0, n);
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aHeading') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
      (geo.getAttribute('aSelected') as THREE.BufferAttribute).needsUpdate = true;
    },

    setCameraDistance(d: number) {
      uniforms.uCameraDist.value = d;
      uniforms.uTime.value += 0.016;
    },

    setVisible(v: boolean) {
      group.visible = v;
    },

    setSelected(callsign: string | null) {
      selectedCallsign = callsign;
      // 重新标记选中位
      const n = Math.min(current.length, MAX_AIRCRAFT);
      for (let i = 0; i < n; i++) {
        selectedFlags[i] = callsign && current[i].callsign === callsign ? 1 : 0;
      }
      (geo.getAttribute('aSelected') as THREE.BufferAttribute).needsUpdate = true;
    },

    pick(nx: number, ny: number, camera: THREE.Camera, viewportHeight = 900): number {
      const projected = new THREE.Vector3();
      // 触控/鼠标统一按 14px 容差
      let bestD = (14 / viewportHeight) * 2;
      let best = -1;
      const n = Math.min(current.length, MAX_AIRCRAFT);

      for (let i = 0; i < n; i++) {
        projected.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        // 背面剔除：飞机在地球另一侧时不该被点中
        const toCam = camera.position.clone().sub(projected).normalize();
        const outward = projected.clone().normalize();
        if (toCam.dot(outward) <= 0.02) continue;

        projected.project(camera);
        if (projected.z > 1) continue;
        const d = Math.hypot(projected.x - nx, projected.y - ny);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },

    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
