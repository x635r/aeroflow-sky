import { describe, expect, it } from 'vitest';
import {
  toVec3,
  fromVec3,
  tangentBasis,
  greatCircleDistance,
  initialBearing,
  type Vec3,
} from '../src/core/geo';

/**
 * 坐标系手性测试
 * ---------------------------------------------------------------------------
 * 这里固定一条容易出错、出错后又不易察觉的性质：**东在右**。
 *
 * 背景：three.js 相机看向 -Z，屏幕右方向是 cross(up, camZ)。
 * 若把经纬度映射成世界坐标时用了 z = +sin(lon)，
 * 从大西洋上空看地球就会得到「纽约在右、伦敦在左」——东西镜像。
 *
 * 这类错误在视觉上很隐蔽（大陆形状本身没错），
 * 但只要把「屏幕右向量」算出来点乘一次就能立刻暴露，所以固化成测试。
 */

/** 复现 three.js PerspectiveCamera.lookAt 的基向量推导 */
function screenBasis(camPos: Vec3): { right: Vec3; up: Vec3; forward: Vec3 } {
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  // 相机局部 +Z 指向相机背后（远离注视点）
  const backward = norm(sub(camPos, [0, 0, 0]));
  const worldUp: Vec3 = [0, 1, 0];
  const right = norm(cross(worldUp, backward));
  const up = cross(backward, right);
  return { right, up, forward: [-backward[0], -backward[1], -backward[2]] };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 某点在某相机视角下的屏幕横向位置（正 = 屏幕右侧） */
function screenX(camPos: Vec3, lat: number, lon: number): number {
  const { right } = screenBasis(camPos);
  return dot(toVec3(lat, lon, 1), right);
}

describe('坐标系手性：东必须在右', () => {
  it('赤道视角：+90°E 位于屏幕右侧，-90°W 位于左侧', () => {
    // 相机位于 (0°, 0°) 正上方，看向地心
    const cam = toVec3(0, 0, 3);
    expect(screenX(cam, 0, 90)).toBeGreaterThan(0.5);
    expect(screenX(cam, 0, -90)).toBeLessThan(-0.5);
  });

  it('大西洋视角：伦敦在纽约的左侧（真实地理关系）', () => {
    const cam = toVec3(22, -38, 3.05);
    const london = screenX(cam, 51.5, -0.5);
    const newYork = screenX(cam, 40.6, -73.8);
    // 从大西洋往东看，纽约在西（屏幕左），伦敦在东（屏幕右）
    // 注意：相机在大西洋上空向地心看时，「东」大致指向屏幕右侧
    expect(newYork).toBeLessThan(london);
  });

  it('自西向东的位移在屏幕上必须是向右移动', () => {
    const cam = toVec3(0, 0, 3);
    // 沿赤道从 -20°E 走到 +20°E
    const west = screenX(cam, 0, -20);
    const east = screenX(cam, 0, 20);
    expect(east).toBeGreaterThan(west);
  });

  it('北在屏幕上方', () => {
    const cam = toVec3(0, 0, 3);
    const { up } = screenBasis(cam);
    expect(dot(toVec3(60, 0, 1), up)).toBeGreaterThan(0.5);
    expect(dot(toVec3(-60, 0, 1), up)).toBeLessThan(-0.5);
  });
});

describe('toVec3 / fromVec3 互逆', () => {
  it('往返精度优于 1e-9', () => {
    for (const lat of [-85, -45, 0, 12.5, 45, 85]) {
      for (const lon of [-179, -90, -0.5, 0, 33.3, 90, 179]) {
        const v = toVec3(lat, lon, 1);
        const back = fromVec3(v);
        expect(Math.abs(back.lat - lat)).toBeLessThan(1e-9);
        const dLon = Math.abs(((back.lon - lon + 540) % 360) - 180);
        expect(dLon).toBeLessThan(1e-9);
      }
    }
  });

  it('极点在往返中保持纬度', () => {
    expect(fromVec3(toVec3(90, 0)).lat).toBeCloseTo(90, 9);
    expect(fromVec3(toVec3(-90, 0)).lat).toBeCloseTo(-90, 9);
  });

  it('单位向量长度为 1', () => {
    for (const [lat, lon] of [
      [0, 0],
      [45, 123],
      [-67, -45],
    ]) {
      const v = toVec3(lat, lon, 1);
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 12);
    }
  });
});

describe('切平面基向量与坐标系一致', () => {
  it('east 指向经度增大方向', () => {
    for (const [lat, lon] of [
      [0, 0],
      [30, 100],
      [-45, -60],
      [60, -170],
    ]) {
      const p = toVec3(lat, lon, 1);
      const { east } = tangentBasis(p);
      // 沿东走一小步
      const next = toVec3(lat, lon + 0.01, 1);
      const step: Vec3 = [next[0] - p[0], next[1] - p[1], next[2] - p[2]];
      expect(dot(step, east)).toBeGreaterThan(0);
    }
  });

  it('north 指向纬度增大方向', () => {
    for (const [lat, lon] of [
      [0, 0],
      [30, 100],
      [-45, -60],
    ]) {
      const p = toVec3(lat, lon, 1);
      const { north } = tangentBasis(p);
      const next = toVec3(lat + 0.01, lon, 1);
      const step: Vec3 = [next[0] - p[0], next[1] - p[1], next[2] - p[2]];
      expect(dot(step, north)).toBeGreaterThan(0);
    }
  });

  it('三个基向量两两正交且单位长', () => {
    const p = toVec3(35, -120, 1);
    const { east, north, up } = tangentBasis(p);
    for (const v of [east, north, up]) {
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 12);
    }
    expect(dot(east, north)).toBeCloseTo(0, 12);
    expect(dot(east, up)).toBeCloseTo(0, 12);
    expect(dot(north, up)).toBeCloseTo(0, 12);
  });
});

describe('方位角不受坐标系影响', () => {
  it('纽约到伦敦的初始航向约 51°', () => {
    const jfk = { lat: 40.6413, lon: -73.7781 };
    const lhr = { lat: 51.47, lon: -0.4614 };
    const b = initialBearing(jfk, lhr);
    // 教科书值约 51°（西北偏东）
    expect(b).toBeGreaterThan(48);
    expect(b).toBeLessThan(54);
  });

  it('东京到洛杉矶初始航向约 55°（向东北走大圆）', () => {
    const nrt = { lat: 35.772, lon: 140.392 };
    const lax = { lat: 33.9416, lon: -118.4085 };
    const b = initialBearing(nrt, lax);
    expect(b).toBeGreaterThan(40);
    expect(b).toBeLessThan(80);
  });

  it('距离与坐标系手性无关（反对称性）', () => {
    const a = { lat: 10, lon: 20 };
    const b = { lat: -30, lon: 150 };
    expect(greatCircleDistance(a, b)).toBeCloseTo(greatCircleDistance(b, a), 6);
  });
});
