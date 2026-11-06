/**
 * GPU 急流粒子系统
 * ---------------------------------------------------------------------------
 * 采用「经纬空间累积拖尾」架构，而不是逐帧画线段，原因有三：
 *
 *  1. 拖尾长度与帧率解耦：无论 30fps 还是 144fps，轨迹都按真实经过的
 *     经纬路径累积，不会在低帧率时变成断续的短划线。
 *  2. 全景一致：拖尾直接存在等距圆柱空间里，再贴回球面，因此极区
 *     压缩、跨 180° 经线都不会出现接缝。
 *  3. 粒子数量可与屏幕分辨率解耦：状态纹理 512² ≈ 26 万条流线同时流动，
 *     而屏幕叠加只是一次纹理采样。
 *
 * 数据流：
 *   状态纹理 (lon, lat, prevLon, age) ping-pong
 *      → 平流：采样风场 RGBA16F，按风速推进
 *      → 拖尾缓冲：上一帧 × fade + 本帧粒子点
 *      → 球面壳：加法混合采样拖尾缓冲
 */

import * as THREE from 'three';
import type { WindField } from '../data/windField';
import { createLutTexture } from './windTexture';
import { createEquirectSphere } from './globe';
import { WIND_RAMP } from './palette';
import type { DeviceProfile } from './deviceProfile';

const SIM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const SIM_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uState;      // (lon01, lat01, prevLon01, age)
  uniform sampler2D uWind;       // (u, v, cat, speed)
  uniform vec2  uStateSize;
  uniform float uDelta;          // 真实秒
  uniform float uLifetime;       // 真实秒（粒子寿命）
  uniform float uSpeedScale;     // 模拟秒 / 真实秒
  uniform float uSeed;           // 每次重置时变化
  uniform float uReseed;         // 随时间推进的重生相位

  // 2D → 1D hash，用于重生位置
  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  // 重生位置
  // ------------------------------------------------------------------
  // 这里必须「完全随机」而不是「按像素格确定性映射」。
  // 如果重生点由 (cell, seed) 唯一决定，所有粒子会在同一组经纬上排队重生，
  // 沿同一条流线反复走同一条弧，画面就会出现明显的同心圆伪影。
  // 因此额外引入一个随时间变化的 uReseed，让每一轮重生都换一批落点。
  vec2 respawn(vec2 cell) {
    float k = uSeed + uReseed * 7.137;
    float a = hash21(cell * 0.731 + k);
    float b = hash21(cell * 1.913 + k * 1.373 + 11.0);
    float c = hash21(cell * 3.771 + k * 2.119 + 47.0);
    // 混入第三维哈希，彻底打断格子结构
    a = fract(a + c * 0.37);
    b = fract(b + c * 0.61);
    // 纬度用 asin 反变换，保证球面上密度均匀（否则两极会堆叠）
    float lat = asin(clamp(2.0 * b - 1.0, -1.0, 1.0)) / 3.14159265 + 0.5;
    return vec2(a, lat);
  }

  void main() {
    vec4 st = texture2D(uState, vUv);
    vec2 pos = st.xy;
    float age = st.w;

    // 首次：age < 0 表示尚未初始化
    if (age < -0.5) {
      vec2 r = respawn(vUv * uStateSize + uSeed);
      float a0 = hash21(vUv * 91.7 + uSeed) * 0.999;
      gl_FragColor = vec4(r, r.x, a0);
      return;
    }

    // 本帧起点（上一帧的终点），用于把两步位置连成线段
    float prevLon = pos.x;

    vec4 w = texture2D(uWind, vec2(pos.x, pos.y));
    float u = w.r;
    float v = w.g;
    float speed = w.a;

    float latRad = (pos.y - 0.5) * 3.14159265;
    float cosLat = max(cos(latRad), 0.08);

    // 位移（米）= 风矢量 × 模拟经过时间；再除以每度米数得到经纬度增量。
    // 模拟时间 = 真实秒 × uSpeedScale（默认 2600 ≈ 43 分钟/秒），
    // 这样 90 m/s 的急流每真实秒推进约 2.1°，肉眼可读而不会瞬移。
    const float M_PER_DEG = 111320.0;
    float simSeconds = uDelta * uSpeedScale;
    float dLon = (u / cosLat) * simSeconds / M_PER_DEG;
    float dLat = v * simSeconds / M_PER_DEG;

    pos.x = fract(pos.x + dLon);
    pos.y = clamp(pos.y + dLat, 0.002, 0.998);

    // age 以「真实秒」为单位推进，与寿命直接比较
    age += uDelta / uLifetime;

    // 弱风区的粒子几乎不动，会堆成静止的圆点，破坏「流动」的观感。
    // 让它们在早期就重生，把有限的粒子预算留给真正的急流带。
    if (speed < 7.0 && age > 0.16) {
      vec2 r = respawn(vUv * uStateSize + uSeed * 5.7 + floor(uSeed + age * 31.0));
      gl_FragColor = vec4(r, r.x, 0.0);
      return;
    }

    if (age > 1.0) {
      vec2 r = respawn(vUv * uStateSize + uSeed * 3.1 + floor(uSeed + age * 17.0));
      gl_FragColor = vec4(r, r.x, 0.0);
      return;
    }

    // z 通道存「上一帧的经度」，用于把两步位置连成线段
    gl_FragColor = vec4(pos, prevLon, age);
  }
`;

const POINT_VERT = /* glsl */ `
  precision highp float;
  varying float vAge;
  varying float vSpeed;
  varying float vCat;
  varying float vT;

  uniform sampler2D uState;
  uniform sampler2D uWind;
  uniform float uPointSize;
  uniform vec2 uStateSize;

  void main() {
    vec4 st = texture2D(uState, uv);
    vec2 pos = st.xy;
    vec4 w = texture2D(uWind, vec2(pos.x, pos.y));

    vAge = st.w;
    vSpeed = w.a;
    vCat = w.b;
    vT = 1.0;

    gl_Position = vec4(pos.x * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = uPointSize;
  }
`;

const POINT_FRAG = /* glsl */ `
  precision highp float;
  varying float vAge;
  varying float vSpeed;
  varying float vCat;

  uniform sampler2D uLut;
  uniform float uMaxSpeed;
  uniform float uIntensity;
  uniform float uShowCat;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    // 高斯型软边：让点与点之间自然融合成连续流线，而不是一颗颗硬圆点
    float soft = exp(-r2 * 9.0) * 1.15;

    float t = clamp(vSpeed / uMaxSpeed, 0.0, 1.0);
    vec3 col = texture2D(uLut, vec2(pow(t, 0.85), 0.5)).rgb;
    // 极高速再叠加一层白热，模拟真实急流核的过曝感
    col += vec3(0.55, 0.62, 0.66) * pow(t, 6.0);

    // 粒子生命周期淡入淡出，避免突然出现/消失
    float life = smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.7, 1.0, vAge));
    // 强风粒子更亮更实，弱风几乎不可见 → 视觉上只留下急流带
    float speedWeight = pow(clamp((t - 0.12) / 0.88, 0.0, 1.0), 2.6) * 2.4;

    float alpha = life * speedWeight * uIntensity * soft;

    if (uShowCat > 0.5) {
      // 湍流模式：只保留 CAT 高的粒子，颜色转向琥珀
      float cat = smoothstep(0.35, 0.85, vCat);
      alpha *= (0.15 + cat * 0.85);
      col = mix(col, vec3(1.0, 0.62, 0.22), cat * 0.75);
    }

    gl_FragColor = vec4(col * alpha, 1.0);
  }
`;

const FADE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrev;
  uniform float uFade;     // 每帧衰减系数（已在 JS 侧做帧率归一）
  void main() {
    vec4 c = texture2D(uPrev, vUv);
    gl_FragColor = vec4(c.rgb * uFade, c.a * uFade);
  }
`;

const INIT_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uSeed;

  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  void main() {
    float a = hash21(vUv * 613.0 + uSeed);
    float b = hash21(vUv * 271.0 + uSeed * 1.7 + 5.0);
    float lat = asin(clamp(2.0 * b - 1.0, -1.0, 1.0)) / 3.14159265 + 0.5;
    // age 起点随机（0..0.999），避免所有粒子同时重生造成脉动
    float a0 = hash21(vUv * 31.0 + uSeed) * 0.999;
    gl_FragColor = vec4(a, lat, a, a0);
  }
`;

const COMPOSITE_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  uniform sampler2D uTrail;
  uniform vec3 uSunDir;
  uniform float uOpacity;

  void main() {
    vec4 c = texture2D(uTrail, vUv);
    if (c.a < 0.002) discard;

    vec3 n = normalize(vNormalW);
    vec3 viewDir = normalize(cameraPosition - vPosW);
    float facing = abs(dot(n, viewDir));
    float rim = pow(1.0 - facing, 1.6);
    // 球体边缘压暗，让球面看起来是「包裹」的而不是贴片
    float edgeFade = mix(0.5, 1.0, smoothstep(0.0, 0.55, facing));
    // 太阳侧略亮，贴合卫星视角
    float sun = 0.78 + 0.22 * smoothstep(-0.6, 0.8, dot(n, normalize(uSunDir)));

    vec3 col = c.rgb * sun;
    float a = c.a * uOpacity * edgeFade;
    vec3 glow = col * a * 1.0 + col * rim * 0.28;
    gl_FragColor = vec4(glow, 1.0);
  }
`;

export type JetParams = {
  maxSpeed: number;
  intensity: number;
  showCat: boolean;
  pointSize: number;
  speedMultiplier: number;
  trailFade: number;
  lifetime: number;
  opacity: number;
};

export class JetParticles {
  readonly group: THREE.Group;

  private renderer: THREE.WebGLRenderer;
  private stateSize: number;
  /** 实际分配的拖尾缓冲宽度（可能低于目标值） */
  readonly trailWidth: number;
  readonly particleCount: number;
  private stateA: THREE.WebGLRenderTarget;
  private stateB: THREE.WebGLRenderTarget;
  private trailA: THREE.WebGLRenderTarget;
  private trailB: THREE.WebGLRenderTarget;

  private simMaterial: THREE.ShaderMaterial;
  private pointMaterial: THREE.ShaderMaterial;
  private fadeMaterial: THREE.ShaderMaterial;
  private compositeMaterial: THREE.ShaderMaterial;

  private simScene: THREE.Scene;
  private simCamera: THREE.OrthographicCamera;
  private pointScene: THREE.Scene;
  private pointCamera: THREE.OrthographicCamera;
  private fadeScene: THREE.Scene;
  private fadeCamera: THREE.OrthographicCamera;
  private quad: THREE.Mesh;

  private points: THREE.Points;
  private sphere: THREE.Mesh;
  private lut: THREE.DataTexture;

  private frame = 0;
  private seed = 0;
  private needsReset = true;
  private disposed = false;

  private initMaterial: THREE.ShaderMaterial;

  constructor(
    renderer: THREE.WebGLRenderer,
    windTexture: THREE.DataTexture,
    profile: DeviceProfile,
    opts?: Partial<JetParams>,
  ) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'jet-particles';

    // 粒子数是性能与观感的主要旋钮。分级由 deviceProfile 统一决定，
    // 不再靠 UA 猜（iPadOS 会上报桌面 UA）。
    this.stateSize = profile.particleSize;

    // 纹理格式与尺寸必须按设备能力收敛：
    // 4096×2048 的 RGBA16F 在低端 GPU/移动浏览器上会超过 maxTextureSize，
    // 创建出来是 incomplete framebuffer —— three 只打警告，表现为整个急流层
    // 全黑且没有任何降级。HalfFloat 也需要扩展支持。
    const caps = renderer.capabilities;
    const maxTex = caps.maxTextureSize ?? 2048;
    const halfFloatOK =
      renderer.extensions.has('EXT_color_buffer_half_float') ||
      renderer.extensions.has('EXT_color_buffer_float');
    const rtType = halfFloatOK ? THREE.HalfFloatType : THREE.ByteType;

    const stateOpts: THREE.RenderTargetOptions = {
      type: rtType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    this.stateA = new THREE.WebGLRenderTarget(this.stateSize, this.stateSize, stateOpts);
    this.stateB = new THREE.WebGLRenderTarget(this.stateSize, this.stateSize, stateOpts);

    let trailW = profile.trailWidth;
    while (trailW > 512 && trailW > maxTex) trailW = Math.floor(trailW / 2);
    const trailH = Math.floor(trailW / 2);
    const trailOpts: THREE.RenderTargetOptions = {
      type: rtType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    this.trailA = new THREE.WebGLRenderTarget(trailW, trailH, trailOpts);
    this.trailB = new THREE.WebGLRenderTarget(trailW, trailH, trailOpts);

    this.lut = createLutTexture(WIND_RAMP);

    this.simMaterial = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: SIM_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture },
        uWind: { value: windTexture },
        uStateSize: { value: new THREE.Vector2(this.stateSize, this.stateSize) },
        uDelta: { value: 0.016 },
        uLifetime: { value: 26.0 },
        uSpeedScale: { value: 16000.0 },
        uReseed: { value: 0 },
        uSeed: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.pointMaterial = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: {
        uState: { value: this.stateA.texture },
        uWind: { value: windTexture },
        uLut: { value: this.lut },
        uStateSize: { value: new THREE.Vector2(this.stateSize, this.stateSize) },
        uPointSize: { value: 1.9 },
        uMaxSpeed: { value: 110 },
        uIntensity: { value: 0.95 },
        uShowCat: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    });

    this.fadeMaterial = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: FADE_FRAG,
      uniforms: {
        uPrev: { value: this.trailA.texture },
        uFade: { value: 0.9962 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.initMaterial = new THREE.ShaderMaterial({
      vertexShader: SIM_VERT,
      fragmentShader: INIT_FRAG,
      uniforms: { uSeed: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        uTrail: { value: this.trailA.texture },
        uSunDir: { value: new THREE.Vector3(1, 0.25, 0.4).normalize() },
        uOpacity: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    });

    // ---- 场景与四边形 ----
    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(quadGeo, this.simMaterial);
    this.quad.frustumCulled = false;
    this.simScene.add(this.quad);

    this.fadeScene = new THREE.Scene();
    this.fadeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const fadeQuad = new THREE.Mesh(quadGeo, this.fadeMaterial);
    fadeQuad.frustumCulled = false;
    this.fadeScene.add(fadeQuad);

    // ---- 粒子点（渲染进拖尾缓冲）----
    this.pointScene = new THREE.Scene();
    this.pointCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const count = this.stateSize * this.stateSize;
    const s = this.stateSize;
    const pgeo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = i % s;
      const y = Math.floor(i / s);
      uvs[i * 2] = (x + 0.5) / s;
      uvs[i * 2 + 1] = (y + 0.5) / s;
    }
    pgeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pgeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.points = new THREE.Points(pgeo, this.pointMaterial);
    this.points.frustumCulled = false;
    this.pointScene.add(this.points);

    // ---- 球面合成壳 ----
    const sphereGeo = createEquirectSphere(1.004, 128, 80);
    this.sphere = new THREE.Mesh(sphereGeo, this.compositeMaterial);
    this.sphere.name = 'jet-shell';
    this.sphere.renderOrder = 2;
    this.group.add(this.sphere);

    this.trailWidth = trailW;
    this.particleCount = this.stateSize * this.stateSize;

    if (opts) this.applyParams(opts as JetParams);
    this.reset();
  }

  reset(): void {
    this.needsReset = true;
    this.seed = Math.random() * 1000;
    const seed = this.seed;

    // 用着色器生成合法状态（age 起点随机），比 CPU 半浮点编码可靠
    this.initMaterial.uniforms.uSeed.value = seed;
    this.quad.material = this.initMaterial;

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    // 清屏色是 renderer 的全局状态，用完必须还原，
    // 否则主画布会用我们临时设的透明黑清屏
    const prevClear = r.getClearColor(new THREE.Color()).clone();
    const prevAlpha = r.getClearAlpha();

    r.setRenderTarget(this.stateA);
    r.autoClear = true;
    r.clear();
    r.render(this.simScene, this.simCamera);

    for (const rt of [this.trailA, this.trailB]) {
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.setClearColor(prevClear, prevAlpha);

    this.simMaterial.uniforms.uSeed.value = seed;
    this.simMaterial.uniforms.uState.value = this.stateA.texture;
    this.quad.material = this.simMaterial;
    this.frame = 0;
    this.needsReset = false;
  }

  applyParams(p: Partial<JetParams>): void {
    if (p.maxSpeed !== undefined) this.pointMaterial.uniforms.uMaxSpeed.value = p.maxSpeed;
    if (p.intensity !== undefined) this.pointMaterial.uniforms.uIntensity.value = p.intensity;
    if (p.showCat !== undefined) this.pointMaterial.uniforms.uShowCat.value = p.showCat ? 1 : 0;
    if (p.pointSize !== undefined) this.pointMaterial.uniforms.uPointSize.value = p.pointSize;
    if (p.speedMultiplier !== undefined) {
      this.speedMultiplier = p.speedMultiplier;
    }
    if (p.trailFade !== undefined) this.fadeMaterial.uniforms.uFade.value = p.trailFade;
    if (p.lifetime !== undefined) this.simMaterial.uniforms.uLifetime.value = p.lifetime;
    if (p.opacity !== undefined) this.compositeMaterial.uniforms.uOpacity.value = p.opacity;
  }

  private speedMultiplier = 16000;
  private reseedPhase = 0;

  /** 每帧推进。dt 以秒计。 */
  update(dt: number, windTexture: THREE.DataTexture, levelChanged: boolean): void {
    if (this.disposed) return;
    const clampedDt = Math.min(dt, 0.05);

    if (this.needsReset) {
      this.seed = Math.random() * 1000;
      this.simMaterial.uniforms.uSeed.value = this.seed;
      this.needsReset = false;
      this.frame = 0;
    }

    if (levelChanged) {
      // 换层时重置一部分粒子相位，让新气流的纹理立即显形
      this.seed += 0.37;
      this.simMaterial.uniforms.uSeed.value = this.seed;
    }

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevClear = r.getClearColor(new THREE.Color()).clone();
    const prevAlpha = r.getClearAlpha();

    // 1) 平流 + 画点：在「一次显示帧」内跑 SUBSTEPS 个子步。
    //
    //    单步若走得太远，拖尾缓冲里只留下一个个孤立光点（因为每个粒子
    //    每帧只在拖尾上盖一个点）。把它拆成多个小步、每步都画一次点，
    //    这些点就会自然连成一段连续的短流线——这正是 earth.nullschool
    //    这类实现的常用手法，代价只是多几次全屏 quad。
    const SUBSTEPS = 4;
    const subDelta = clampedDt / SUBSTEPS;

    // 拖尾先做一次全局衰减
    const baseFade = 0.9962;
    this.fadeMaterial.uniforms.uFade.value = Math.pow(baseFade, clampedDt * 60);
    this.fadeMaterial.uniforms.uPrev.value = this.trailA.texture;
    (this.fadeScene.children[0] as THREE.Mesh).material = this.fadeMaterial;

    r.setRenderTarget(this.trailB);
    r.autoClear = false;
    r.render(this.fadeScene, this.fadeCamera);

    let src = this.stateA;
    let dst = this.stateB;

    this.reseedPhase += clampedDt * 3.7;
    this.simMaterial.uniforms.uReseed.value = this.reseedPhase;
    this.simMaterial.uniforms.uWind.value = windTexture;
    this.simMaterial.uniforms.uDelta.value = subDelta;
    this.simMaterial.uniforms.uSpeedScale.value = this.speedMultiplier;
    this.quad.material = this.simMaterial;
    r.setClearColor(0x000000, 0);

    for (let k = 0; k < SUBSTEPS; k++) {
      this.simMaterial.uniforms.uState.value = src.texture;
      r.setRenderTarget(dst);
      r.autoClear = true;
      r.clear();
      r.render(this.simScene, this.simCamera);

      this.pointMaterial.uniforms.uState.value = dst.texture;
      this.pointMaterial.uniforms.uWind.value = windTexture;
      r.setRenderTarget(this.trailB);
      r.autoClear = false;
      r.render(this.pointScene, this.pointCamera);

      const tmp = src;
      src = dst;
      dst = tmp;
    }

    // 循环结束时 src 持有最新状态，把它固定成 stateA
    this.stateA = src;
    this.stateB = dst;

    // 3) 合成壳采样 trailB
    this.compositeMaterial.uniforms.uTrail.value = this.trailB.texture;

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.setClearColor(prevClear, prevAlpha);

    // 4) 交换拖尾缓冲
    const tmpTrail = this.trailA;
    this.trailA = this.trailB;
    this.trailB = tmpTrail;

    this.frame++;
  }

  /** 让球面壳跟随场景更新 uniform（尺寸变化时无需重建） */
  syncCamera(): void {
    // 目前无依赖相机的 uniform，保留接口以便后续加视差
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  setCatMode(on: boolean): void {
    this.pointMaterial.uniforms.uShowCat.value = on ? 1 : 0;
  }

  dispose(): void {
    this.disposed = true;
    this.stateA.dispose();
    this.stateB.dispose();
    this.trailA.dispose();
    this.trailB.dispose();
    this.lut.dispose();
    this.initMaterial.dispose();
    this.simMaterial.dispose();
    this.pointMaterial.dispose();
    this.fadeMaterial.dispose();
    this.compositeMaterial.dispose();
    (this.points.geometry as THREE.BufferGeometry).dispose();
    (this.sphere.geometry as THREE.BufferGeometry).dispose();
    // simScene 与 fadeScene 里的两个 Mesh 共用同一个 quadGeo，
    // 只释放一次（second dispose 虽然幂等，但会掩盖"到底谁持有"的问题）。
    const sharedQuad = this.quad.geometry as THREE.BufferGeometry;
    sharedQuad.dispose();
  }
}

/** 便捷：把 WindField 一帧打到风场纹理上（供外部按需调用） */
export function uploadFrame(field: WindField): void {
  void field;
}
