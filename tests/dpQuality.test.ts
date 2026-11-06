import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeHalf } from '../src/data/windField';
import type { WindField, WindHeader } from '../src/data/windField';
import { planGreatCircle, planWindOptimal, comparePlans } from '../src/sim/routeEngine';
import type { PlanContext } from '../src/sim/routeEngine';
import { aircraftById } from '../src/core/atmos';

const dataDir = path.join(__dirname, '..', 'public', 'data');
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'wind-manifest.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dataDir, manifest.file));
const hdrLen = buf.readUInt32LE(4);
const header = JSON.parse(buf.subarray(8, 8 + hdrLen).toString('utf8')) as WindHeader;
const payload = buf.subarray(8 + hdrLen);
const field: WindField = {
  header, data: decodeHalf(new Uint16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength))),
  grid: header.grid, levels: header.levels.map(l=>l.hPa), steps: header.steps.map(s=>s.hour),
  stridePerLevel: header.grid.nLat*header.grid.nLon*4,
  stepTimestamps: header.steps.map(s=>Date.parse(s.validTime)),
};
const mk = (hPa=250, step=0): PlanContext => ({ field, pressureHpa: hPa, stepPos: step, aircraft: aircraftById('b77w'), mach: 0.84 });

describe('DP 质量', () => {
  it('所有时效 × 所有层：借风航线不慢于大圆', () => {
    const routes = [
      ['JFK','LHR',40.64,-73.78,51.47,-0.46],
      ['SFO','NRT',37.62,-122.38,35.77,140.39],
      ['PEK','JFK',40.08,116.58,40.64,-73.78],
      ['SYD','LAX',-33.94,151.18,33.94,-118.41],
      ['SIN','LHR',1.36,103.99,51.47,-0.46],
    ];
    let violations = 0;
    for (const step of [0, 1, 2, 3, 4]) {
      for (const hPa of [200, 250, 300]) {
        const ctx = mk(hPa, step);
        for (const [, , lat1, lon1, lat2, lon2] of routes) {
          const cmp = comparePlans(ctx, { lat: lat1 as number, lon: lon1 as number }, { lat: lat2 as number, lon: lon2 as number });
          const faster = cmp.optimal.duration <= cmp.gc.duration * 1.0001;
          if (!faster) { violations++; console.log(`违反: step=${step} ${hPa}hPa ${lat1},${lon1}→${lat2},${lon2} dp=${(cmp.optimal.duration/60).toFixed(1)} gc=${(cmp.gc.duration/60).toFixed(1)}`); }
        }
      }
    }
    console.log('总检查 75 个组合，违反', violations);
    expect(violations).toBe(0);
  });

  it('横向偏离是否真的发生（不是永远贴大圆）', () => {
    const ctx = mk(250, 0);
    const routes = [
      ['JFK→LHR', { lat: 40.64, lon: -73.78 }, { lat: 51.47, lon: -0.46 }],
      ['SFO→NRT', { lat: 37.62, lon: -122.38 }, { lat: 35.77, lon: 140.39 }],
      ['PEK→JFK', { lat: 40.08, lon: 116.58 }, { lat: 40.64, lon: -73.78 }],
    ];
    for (const [name, a, b] of routes) {
      const dp = planWindOptimal(ctx, a as never, b as never);
      const gc = planGreatCircle(ctx, a as never, b as never);
      console.log(`${name}: dev=${dp.deviationDeg.toFixed(2)}° saved=${((gc.duration-dp.duration)/60).toFixed(1)}min extra=${(dp.extraDistance/1000).toFixed(0)}km`);
    }
  });

  it('DP 路径平滑度：相邻站的横向位移不应剧烈跳动', () => {
    const ctx = mk(250, 0);
    const dp = planWindOptimal(ctx, { lat: 37.62, lon: -122.38 }, { lat: 35.77, lon: 140.39 });
    // 计算相邻航段航迹角的变化
    const turns: number[] = [];
    for (let i = 1; i < dp.points.length - 1; i++) {
      const a = dp.points[i-1], b = dp.points[i], c = dp.points[i+1];
      const angle = (p1: typeof a, p2: typeof b) => {
        const dLon = ((p2.lon - p1.lon + 540) % 360) - 180;
        return Math.atan2(dLon * Math.cos((p1.lat*Math.PI)/180), p2.lat - p1.lat);
      };
      let d = angle(a, b) - angle(b, c);
      while (d > Math.PI) d -= 2*Math.PI;
      while (d < -Math.PI) d += 2*Math.PI;
      turns.push(Math.abs(d * 180 / Math.PI));
    }
    const maxTurn = Math.max(...turns);
    const avgTurn = turns.reduce((s,x)=>s+x,0)/turns.length;
    console.log(`航迹角变化: 最大 ${maxTurn.toFixed(1)}° 平均 ${avgTurn.toFixed(1)}° 采样 ${turns.length}`);
    // 端点附近必然有一次较大转向（要从巡航槽回到目的地），
    // 关键是不要逐站来回横跳。平均 5.5° 说明路径整体平缓。
    expect(maxTurn).toBeLessThan(35);
    expect(avgTurn).toBeLessThan(10);

    // 更强的判据：转向方向的符号变化次数（锯齿会有很多次正负交替）
    let signFlips = 0;
    let prevSign = 0;
    for (const tr of turns) {
      const s = Math.sign(tr);
      if (s !== 0 && prevSign !== 0 && s !== prevSign) signFlips++;
      if (s !== 0) prevSign = s;
    }
    // 这里 turns 都是绝对值，用另一维：检测横向位置是否单调
    const lats = dp.points.map(p => p.lat);
    let latFlips = 0;
    for (let i = 2; i < lats.length; i++) {
      const d1 = lats[i-1] - lats[i-2];
      const d2 = lats[i] - lats[i-1];
      if (d1 * d2 < 0 && Math.abs(d1) > 0.05 && Math.abs(d2) > 0.05) latFlips++;
    }
    console.log(`纬向折返次数: ${latFlips}（锯齿会很多）`);
    expect(latFlips).toBeLessThanOrEqual(2);
    void signFlips;
  });
});
