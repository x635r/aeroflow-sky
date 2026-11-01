/**
 * 地球与大气层几何体
 * ---------------------------------------------------------------------------
 * 视觉分层（由内到外）：
 *   0. 地球球面      —— 海岸线纹理，表面着色器带微弱昼侧/夜侧渐变
 *   1. 急流粒子层    —— 在球面上的 GPU 平流纹理（见 JetParticles）
 *   2. 大气辉光壳    —— 加法混合的 Fresnel 光晕，营造「从太空看」的通透感
 *   3. 星空          —— 固定在天球上的点云
 */

import * as THREE from 'three';
import { toVec3 } from '../core/geo';

export const EARTH_RADIUS = 1;

/**
 * 自建球体几何：显式指定 UV = (lon01, lat01)。
 *
 * 顶点坐标必须与 core/geo.ts 的 toVec3 完全一致的约定：
 *   x = cosφ·cosλ,  y = sinφ,  z = −cosφ·sinλ
 *
 * 不能直接用 three.js 的 SphereGeometry：它的 u 轴是 lon = 180 − 360u，
 * 与本项目的等距圆柱贴图（u = (lon+180)/360）正好镜像。
 * 地表纹理、粒子拖尾缓冲、风场采样三者共用同一套经纬索引，
 * 任何一处偷偷翻转都会造成层间错位，所以这里直接构造自洽的几何。
 */
export function createEquirectSphere(radius: number, lonSeg = 160, latSeg = 96): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iy = 0; iy <= latSeg; iy++) {
    const lat01 = iy / latSeg;
    const lat = -90 + lat01 * 180;
    for (let ix = 0; ix <= lonSeg; ix++) {
      const lon01 = ix / lonSeg;
      const lon = -180 + lon01 * 360;
      // 直接复用 core/geo 的 toVec3，杜绝这里出现第二套符号约定
      const [x, y, z] = toVec3(lat, lon, radius);
      positions.push(x, y, z);
      normals.push(x / radius, y / radius, z / radius);
      uvs.push(lon01, lat01);
    }
  }

  const row = lonSeg + 1;
  for (let iy = 0; iy < latSeg; iy++) {
    for (let ix = 0; ix < lonSeg; ix++) {
      const a = iy * row + ix;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // 绕序决定正面朝向：z 取负后需要同样翻转三角形绕序，
      // 否则法线朝内、球体变成「从里面看」
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

export function createEarth(landTexture: THREE.Texture): THREE.Mesh {
  const geometry = createEquirectSphere(EARTH_RADIUS, 192, 120);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLand: { value: landTexture },
      uSunDir: { value: new THREE.Vector3(1, 0.28, 0.45).normalize() },
      uRim: { value: new THREE.Color('#5cc8ee') },
    },
    vertexShader: /* glsl */ `
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
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uLand;
      uniform vec3 uSunDir;
      uniform vec3 uRim;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;

      void main() {
        vec3 n = normalize(vNormalW);
        float sun = dot(n, normalize(uSunDir));
        // 昼夜过渡带比地理尺度宽，符合从轨道看到的晨昏线观感
        float lit = smoothstep(-0.42, 0.62, sun);
        float night = 1.0 - lit;

        vec4 land = texture2D(uLand, vUv);
        // 贴图已被做成「纯遮罩」：alpha = 陆地覆盖率（抗锯齿给出 0..1 的过渡）
        float landMask = clamp(land.a, 0.0, 1.0);

        // 海洋：高纬略暗，模拟真实海水的反照率分布
        float latAbs = abs(n.y);
        vec3 ocean = mix(vec3(0.0016, 0.0055, 0.017), vec3(0.005, 0.021, 0.048), lit);
        ocean *= mix(1.0, 0.72, smoothstep(0.6, 1.0, latAbs));

        // 陆地只比海洋亮一档的冷灰蓝：保住轮廓但不与青色粒子争视觉焦点
        vec3 landCol = mix(vec3(0.016, 0.026, 0.032), vec3(0.044, 0.064, 0.072), lit);
        // 夜侧陆地保留极弱底光，避免大陆完全消失
        landCol += vec3(0.006, 0.009, 0.012) * night;

        vec3 base = mix(ocean, landCol, landMask);

        // 大气边缘散射（只在地球轮廓处）
        vec3 viewDir = normalize(cameraPosition - vPosW);
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.2);
        base += uRim * fres * 0.13;

        gl_FragColor = vec4(base, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'earth';
  return mesh;
}

/** 大气辉光：略大于地球的球壳，背面渲染 + 加法混合 */
export function createAtmosphere(radius = 1.022): THREE.Mesh {
  const geometry = createEquirectSphere(radius, 96, 64);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#3fa9d8') },
      uIntensity: { value: 0.62 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 n = normalize(vNormalW);
        vec3 viewDir = normalize(cameraPosition - vPosW);
        float rim = pow(1.0 - abs(dot(n, viewDir)), 5.2);
        float alpha = rim * uIntensity * 0.42;
        gl_FragColor = vec4(uColor * alpha, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  return mesh;
}

/** 星空点云：球壳内随机分布，尺寸与亮度随机 */
export function createStarfield(count = 3200, radius = 60): THREE.Points {
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const tint = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 均匀球面分布
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const R = radius * (1 + Math.random() * 0.35);
    pos[i * 3] = R * r * Math.cos(theta);
    pos[i * 3 + 1] = R * u;
    pos[i * 3 + 2] = R * r * Math.sin(theta);
    size[i] = 0.6 + Math.pow(Math.random(), 3.2) * 2.4;
    tint[i] = Math.random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aTint;
      uniform float uPixelRatio;
      varying float vTint;
      varying float vAlpha;
      void main() {
        vTint = aTint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * 1.35;
        vAlpha = smoothstep(120.0, 40.0, length(mv.xyz)) * 0.9 + 0.25;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vTint;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float core = smoothstep(0.5, 0.0, r);
        // 冷白 → 淡蓝 → 微暖 的星色分布
        vec3 c = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.96, 0.88), smoothstep(0.4, 1.0, vTint));
        c = mix(c, vec3(0.55, 0.72, 1.0), smoothstep(0.5, 0.0, vTint) * 0.6);
        gl_FragColor = vec4(c * core * vAlpha, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';
  return points;
}

/** 经纬网线框（可选，作为数据坐标参考） */
export function createGraticule(radius = 1.001, stepDeg = 30, color = 0x2a6b8a): THREE.LineSegments {
  const pts: number[] = [];

  const push = (lat: number, lon: number) => {
    // 与 toVec3 同一约定（z 取负），否则经纬网会与大陆错位
    const v = toVec3(lat, lon, radius);
    pts.push(v[0], v[1], v[2]);
  };

  for (let lat = -60; lat <= 60; lat += stepDeg) {
    for (let lon = -180; lon < 180; lon += 2) {
      push(lat, lon);
      push(lat, lon + 2);
    }
  }
  for (let lon = -180; lon < 180; lon += stepDeg) {
    for (let lat = -88; lat < 88; lat += 2) {
      push(lat, lon);
      push(lat + 2, lon);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}
