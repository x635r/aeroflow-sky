/**
 * 场景宿主：three.js 生命周期、相机、交互、昼夜与性能自适应
 * ---------------------------------------------------------------------------
 * 这一层只做「把东西画出来」，不含任何业务判断。
 * 业务数据通过 setter 推入，避免 UI 直接触碰 three 对象。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEarth, createAtmosphere, createStarfield, createGraticule } from './globe';
import { rasterizeLand, type LandPolygon } from './landTexture';
import { JetParticles, type JetParams } from './JetParticles';
import { createRouteLine, createTurbulenceTubes, createAirportMarker, createAircraftMarker, type RouteVisuals } from './routes';
import { toVec3, fromVec3 } from '../core/geo';
import type { WindField } from '../data/windField';
import { createWindTexture } from '../render/windTexture';
import type { RouteResult } from '../sim/routeEngine';

export type SceneStats = {
  fps: number;
  drawCalls: number;
  triangles: number;
  particleCount: number;
};

export type SceneCallbacks = {
  onHover?: (lat: number, lon: number) => void;
  onPick?: (lat: number, lon: number) => void;
  onStats?: (stats: SceneStats) => void;
  onReady?: () => void;
};

export class GlobeScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;

  private earth: THREE.Mesh | null = null;
  private atmosphere: THREE.Mesh | null = null;
  private starfield: THREE.Points | null = null;
  private graticule: THREE.LineSegments | null = null;
  private jet: JetParticles | null = null;

  private windTex: ReturnType<typeof createWindTexture> | null = null;

  private routeVisuals: RouteVisuals | null = null;
  private gcVisuals: RouteVisuals | null = null;
  private rhumbVisuals: RouteVisuals | null = null;
  private turbulence: THREE.Group | null = null;
  private markers: THREE.Group = new THREE.Group();
  private aircraftMarker: THREE.Group | null = null;

  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;

  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastStatsAt = 0;

  private quality: 'high' | 'medium' | 'low' = 'high';
  private adaptiveDownscale = 1;

  private cb: SceneCallbacks = {};
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerInside = false;
  private lastHoverAt = 0;
  private dragStart: { x: number; y: number; t: number } | null = null;

  private framesRendered = 0;
  private currentLevelPos = 1;
  private currentStepPos = 0;
  private lastLevelPos = -1;
  private visibleLayers = { jet: true, gc: true, rhumb: false, cat: true, grid: false };

  constructor(container: HTMLElement, callbacks: SceneCallbacks = {}) {
    this.container = container;
    this.cb = callbacks;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    this.quality = isMobile ? 'medium' : 'high';

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.6 : 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.setClearColor(0x03060c, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.01, 200);
    const camStart = toVec3(22, -38, 3.05);
    this.camera.position.set(camStart[0], camStart[1], camStart[2]);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.rotateSpeed = 0.52;
    this.controls.zoomSpeed = 0.75;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.28;
    this.controls.maxDistance = 7.5;
    this.controls.autoRotate = false;

    this.scene.add(this.markers);
    this.buildStaticScene();

    this.attachEvents();
    this.start();
    this.exposeDebugHooks();
  }

  /**
   * 调试钩子：把渲染推进从「等 rAF」变成「可确定性调用」。
   *
   * 存在的理由：在无头/被遮挡的窗格里 Chromium 会把 requestAnimationFrame
   * 节流到接近零帧，自动化验收就无法判断平流与拖尾是否正确。
   * `__aeroStep(n)` 同步推进 n 帧，既用于回归验证，也用于生成审查截图。
   * 生产环境里它不产生任何开销，因为只有被显式调用时才执行。
   */
  private exposeDebugHooks(): void {
    const w = window as unknown as Record<string, unknown>;
    w.__aeroStep = (n = 1, dt = 1 / 60) => {
      for (let i = 0; i < n; i++) {
        if (this.jet && this.windTex) {
          this.jet.update(dt, this.windTex.texture, false);
        }
        if (this.starfield) this.starfield.rotation.y += dt * 0.0022;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      return { frames: n, jet: !!this.jet };
    };
    w.__aeroState = () => ({
      running: this.running,
      raf: this.raf,
      frames: this.framesRendered,
      hasJet: !!this.jet,
      hasEarth: !!this.earth,
      levelPos: this.currentLevelPos,
      stepPos: this.currentStepPos,
      camera: this.camera.position.toArray().map((v) => +v.toFixed(3)),
    });

    /**
     * 经纬度 → 屏幕归一化坐标。
     *
     * 用 camera.project() 而不是自己算点积：投影矩阵是判据的唯一真相。
     * 自己推导基向量时若带着同样的符号错误，就会「验证通过」却依然是错的。
     * x ∈ [-1, 1]，-1 = 屏幕最左，+1 = 最右；z > 1 表示在相机后方。
     */
    w.__aeroProbe = (lat: number, lon: number) => {
      const v = new THREE.Vector3(...toVec3(lat, lon, 1));
      v.project(this.camera);
      return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
    };

    /** 把相机放到指定经纬度正上方，用于可复现的镜像断言 */
    w.__aeroLookFrom = (lat: number, lon: number, dist = 3.05) => {
      const p = toVec3(lat, lon, dist);
      this.camera.position.set(p[0], p[1], p[2]);
      this.controls.target.set(0, 0, 0);
      // 先同步 controls 的内部状态，否则下一次 update() 会用旧的球坐标把相机拽回去
      this.controls.update();
      this.camera.lookAt(0, 0, 0);
      this.renderer.render(this.scene, this.camera);
      return {
        lat,
        lon,
        dist,
        camera: this.camera.position.toArray().map((v) => +v.toFixed(3)),
      };
    };
  }

  private buildStaticScene(): void {
    this.starfield = createStarfield(this.quality === 'low' ? 1400 : 3000);
    this.scene.add(this.starfield);

    this.atmosphere = createAtmosphere(1.032);
    this.scene.add(this.atmosphere);

    this.graticule = createGraticule(1.0015, 30);
    this.graticule.visible = false;
    this.scene.add(this.graticule);
  }

  async loadLand(polygons: LandPolygon[]): Promise<void> {
    const tex = rasterizeLand(polygons, {
      width: this.quality === 'low' ? 2048 : 4096,
      height: this.quality === 'low' ? 1024 : 2048,
    });
    const texture = new THREE.CanvasTexture(tex);
    // 这张纹理是「遮罩 + 明度」而不是照片，按线性解释才不会被 sRGB 解码压暗
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;

    this.earth = createEarth(texture);
    this.earth.renderOrder = 0;
    this.scene.add(this.earth);
    this.cb.onReady?.();
  }

  async attachWind(field: WindField): Promise<void> {
    this.windTex = createWindTexture(field);
    this.windTex.update(this.currentLevelPos, this.currentStepPos);

    this.jet = new JetParticles(this.renderer, this.windTex.texture);
    this.jet.group.visible = this.visibleLayers.jet;
    this.scene.add(this.jet.group);
  }

  setWindFrame(levelPos: number, stepPos: number): void {
    this.currentLevelPos = levelPos;
    this.currentStepPos = stepPos;
    if (!this.windTex) return;
    this.windTex.update(levelPos, stepPos);
  }

  setJetParams(p: Partial<JetParams>): void {
    this.jet?.applyParams(p);
  }

  setLayerVisibility(layer: 'jet' | 'gc' | 'rhumb' | 'cat' | 'grid', on: boolean): void {
    this.visibleLayers[layer] = on;
    if (layer === 'jet') this.jet?.setVisible(on);
    if (layer === 'gc') this.gcVisuals?.setVisible(on);
    if (layer === 'rhumb') this.rhumbVisuals?.setVisible(on);
    if (layer === 'cat') {
      if (this.turbulence) this.turbulence.visible = on;
      const overlay = this.routeVisuals?.group.getObjectByName('cat-overlay');
      if (overlay) (overlay as THREE.Mesh).visible = on;
    }
    if (layer === 'grid' && this.graticule) this.graticule.visible = on;
  }

  clearRoutes(): void {
    for (const v of [this.routeVisuals, this.gcVisuals, this.rhumbVisuals]) {
      if (!v) continue;
      this.scene.remove(v.group);
      v.dispose();
    }
    this.routeVisuals = null;
    this.gcVisuals = null;
    this.rhumbVisuals = null;

    if (this.turbulence) {
      this.scene.remove(this.turbulence);
      this.turbulence.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
      this.turbulence = null;
    }

    this.markers.clear();
  }

  showRoutes(optimal: RouteResult, gc: RouteResult, rhumb?: RouteResult): void {
    this.clearRoutes();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.gcVisuals = createRouteLine(gc, 'greatcircle', { w, h });
    this.gcVisuals.setVisible(this.visibleLayers.gc);
    this.scene.add(this.gcVisuals.group);

    this.routeVisuals = createRouteLine(optimal, 'optimal', { w, h });
    this.scene.add(this.routeVisuals.group);

    if (rhumb) {
      this.rhumbVisuals = createRouteLine(rhumb, 'rhumb', { w, h });
      this.rhumbVisuals.setVisible(this.visibleLayers.rhumb);
      this.scene.add(this.rhumbVisuals.group);
    }

    this.turbulence = createTurbulenceTubes(optimal.points);
    this.turbulence.visible = this.visibleLayers.cat;
    this.scene.add(this.turbulence);

    // 起终点标记
    const first = optimal.points[0];
    const last = optimal.points[optimal.points.length - 1];
    this.markers.add(createAirportMarker(first.lat, first.lon, 0x5ee7c4));
    this.markers.add(createAirportMarker(last.lat, last.lon, 0xff9f6b));
  }

  setAircraftMarkerProgress(t: number, points: RouteResult['points']): void {
    if (!points.length) return;
    if (!this.aircraftMarker) {
      this.aircraftMarker = createAircraftMarker();
      this.scene.add(this.aircraftMarker);
    }
    const idx = Math.min(points.length - 1, Math.max(0, Math.round(t * (points.length - 1))));
    const p = points[idx];
    const v = toVec3(p.lat, p.lon, 1.014);
    this.aircraftMarker.position.set(v[0], v[1], v[2]);
    this.aircraftMarker.visible = true;
  }

  hideAircraftMarker(): void {
    if (this.aircraftMarker) this.aircraftMarker.visible = false;
  }

  /** 把相机平滑地转向某个经纬度 */
  flyTo(lat: number, lon: number, distance = 2.4, duration = 1200): void {
    const from = this.camera.position.clone();
    const dir = new THREE.Vector3(...toVec3(lat, lon, 1));
    const to = dir.multiplyScalar(distance);
    const t0 = performance.now();

    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / duration);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(from, to, e);
      this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.2);
      this.controls.update();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  getCameraLatLon(): { lat: number; lon: number; distance: number } {
    const p = this.camera.position;
    const ll = fromVec3([p.x, p.y, p.z]);
    return { ...ll, distance: p.length() };
  }

  private attachEvents(): void {
    const el = this.renderer.domElement;

    this.pointerMove = (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.pointerInside = true;
    };

    el.addEventListener('pointermove', (e) => this.pointerMove(e));
    el.addEventListener('pointerleave', () => {
      this.pointerInside = false;
    });

    el.addEventListener('pointerdown', (e) => {
      this.dragStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    });

    el.addEventListener('pointerup', (e) => {
      const ds = this.dragStart;
      this.dragStart = null;
      if (!ds) return;
      const moved = Math.hypot(e.clientX - ds.x, e.clientY - ds.y);
      const dt = performance.now() - ds.t;
      // 轻点而非拖动 → 视为拾取
      if (moved < 6 && dt < 400) {
        const hit = this.pickSphere(e.clientX, e.clientY);
        if (hit) this.cb.onPick?.(hit.lat, hit.lon);
      }
    });

    this.onResize = () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      this.routeVisuals?.setResolution(w, h);
      this.gcVisuals?.setResolution(w, h);
      this.rhumbVisuals?.setResolution(w, h);
    };
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  private pointerMove: (e: PointerEvent) => void = () => {};
  private onResize: () => void = () => {};

  private pickSphere(clientX: number, clientY: number): { lat: number; lon: number } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectSphere(sphere, hit)) {
      const ll = fromVec3([hit.x, hit.y, hit.z]);
      return { lat: ll.lat, lon: ll.lon };
    }
    return null;
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.controls.update();

    // 悬停采样节流到 ~14Hz，避免每帧打穿 raycast + 风场采样
    const now = performance.now();
    if (this.pointerInside && now - this.lastHoverAt > 70) {
      this.lastHoverAt = now;
      const hit = this.pickSphere(
        this.renderer.domElement.getBoundingClientRect().left +
          ((this.pointer.x + 1) / 2) * this.renderer.domElement.clientWidth,
        this.renderer.domElement.getBoundingClientRect().top +
          ((1 - this.pointer.y) / 2) * this.renderer.domElement.clientHeight,
      );
      if (hit) this.cb.onHover?.(hit.lat, hit.lon);
    }

    if (this.jet && this.windTex) {
      const levelChanged = Math.abs(this.currentLevelPos - this.lastLevelPos) > 0.01;
      this.lastLevelPos = this.currentLevelPos;
      this.jet.update(dt, this.windTex.texture, levelChanged);
    }

    if (this.starfield) {
      // 星空缓慢自转，强化「在轨观察」的感觉
      this.starfield.rotation.y += dt * 0.0022;
    }

    this.renderer.render(this.scene, this.camera);

    // 供自动化验收读取的运行时探针：帧计数与上一次 tick 间隔
    const w = window as unknown as { __aero?: { frames: number; lastDt: number; levelPos: number; stepPos: number } };
    if (!w.__aero) w.__aero = { frames: 0, lastDt: 0, levelPos: 0, stepPos: 0 };
    this.framesRendered++;
    w.__aero.frames++;
    w.__aero.lastDt = dt;
    w.__aero.levelPos = this.currentLevelPos;
    w.__aero.stepPos = this.currentStepPos;

    // ---- 统计与自适应 ----
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (now - this.lastStatsAt > 600) {
      const fps = this.fpsAccum > 1e-3 ? this.fpsFrames / this.fpsAccum : 0;
      this.lastStatsAt = now;
      this.fpsAccum = 0;
      this.fpsFrames = 0;

      const info = this.renderer.info;
      this.cb.onStats?.({
        fps: Math.round(fps),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        particleCount: this.jet ? 512 * 512 : 0,
      });

      // 帧率过低时自动降粒子分辨率（通过降低点大小与不透明度近似）
      if (fps < 26 && this.adaptiveDownscale > 0.55) {
        this.adaptiveDownscale -= 0.1;
        this.jet?.applyParams({
          pointSize: 1.7 * this.adaptiveDownscale,
          intensity: Math.max(0.5, this.adaptiveDownscale),
        });
      }
    }
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.clearRoutes();
    this.jet?.dispose();
    this.windTex?.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
