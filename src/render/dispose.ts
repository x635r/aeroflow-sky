/**
 * three.js 资源释放
 * ---------------------------------------------------------------------------
 * three 不会自动回收 GPU 资源：`scene.remove()` 只是把对象从图里摘掉，
 * `Object3D.clear()` 连子对象引用都只清一层，二者都不会调用
 * `geometry.dispose()` / `material.dispose()` / `texture.dispose()`。
 *
 * 代价是显存的持续增长——在这个项目里尤其明显：每次切换航线都会
 * 新建 3 条 Line2、若干湍流管和 2 个机场标记，拖动时间轴时每秒重算数十次。
 * 不释放的话几分钟后就会 WebGL context lost（黑屏）。
 */

import * as THREE from 'three';

/** 递归释放一个对象树下的所有几何体、材质与贴图 */
export function disposeObject3D(root: THREE.Object3D | null | undefined): void {
  if (!root) return;

  const textures = new Set<THREE.Texture>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };

    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    const mat = mesh.material;
    if (!mat) return;

    const materials = Array.isArray(mat) ? mat : [mat];
    for (const m of materials) {
      // 收集材质上的贴图（uniforms 里的 sampler 也要处理）
      for (const key of Object.keys(m)) {
        const value = (m as unknown as Record<string, unknown>)[key];
        if (value instanceof THREE.Texture) textures.add(value);
      }
      const uniforms = (m as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
      if (uniforms) {
        for (const u of Object.values(uniforms)) {
          if (u?.value instanceof THREE.Texture) textures.add(u.value);
        }
      }
      m.dispose();
    }
  });

  for (const tex of textures) tex.dispose();

  // 摘掉父子引用，帮助 GC
  root.removeFromParent();
  root.clear();
}

/**
 * 释放整个场景。
 * @param keepTextures 需要保留的贴图（例如由外部管理、后续还要复用的）
 */
export function disposeScene(scene: THREE.Scene, keepTextures?: Set<THREE.Texture>): void {
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (o !== scene) toRemove.push(o);
  });

  for (const obj of toRemove) {
    const mesh = obj as THREE.Mesh & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (mesh.geometry) mesh.geometry.dispose();

    const mat = mesh.material;
    if (!mat) continue;
    const materials = Array.isArray(mat) ? mat : [mat];
    for (const m of materials) {
      const uniforms = (m as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
      if (uniforms) {
        for (const u of Object.values(uniforms)) {
          const v = u?.value;
          if (v instanceof THREE.Texture && !keepTextures?.has(v)) v.dispose();
        }
      }
      m.dispose();
    }
  }

  scene.clear();
}
