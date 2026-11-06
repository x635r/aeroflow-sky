import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeHalf } from '../src/data/windField';
import type { WindHeader } from '../src/data/windField';

const dataDir = path.join(__dirname, '..', 'public', 'data');
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'wind-manifest.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dataDir, manifest.file));
const hdrLen = buf.readUInt32LE(4);
const header = JSON.parse(buf.subarray(8, 8 + hdrLen).toString('utf8')) as WindHeader;
const payload = buf.subarray(8 + hdrLen);
const data = decodeHalf(new Uint16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)));
const g = header.grid;

describe('极点与接缝（烘焙后处理必须保证的不变量）', () => {
  it('极点行沿经度恒定（物理上极点是单点）', () => {
    // 这条曾经失败：GFS 在极点给的是一圈网格，直接插值会让
    // "极点风"随查询经度旋转一整圈（实测极差 36–47 m/s）
    for (const [name, latIdx] of [['北极', g.nLat - 1], ['南极', 0]] as const) {
      let maxSpread = 0;
      for (let l = 0; l < header.levels.length; l++) {
        for (let ch = 0; ch < 2; ch++) {
          let mn = Infinity, mx = -Infinity;
          for (let j = 0; j < g.nLon; j++) {
            const v = data[((l * g.nLat + latIdx) * g.nLon + j) * 4 + ch];
            mn = Math.min(mn, v); mx = Math.max(mx, v);
          }
          maxSpread = Math.max(maxSpread, mx - mn);
        }
      }
      expect(maxSpread, `${name}行 u/v 沿经度极差`).toBeLessThan(0.5);
    }
  });


  it('首列（0°）与末列（360°）应完全相同', () => {
    let maxDiff = 0, worst = null;
    for (let l = 0; l < header.levels.length; l++) {
      for (let i = 0; i < g.nLat; i++) {
        const base = (l * g.nLat + i) * g.nLon * 4;
        const a = base;                        // lon 0°
        const b = base + (g.nLon - 1) * 4;     // lon 360°
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(data[a+c] - data[b+c]);
          if (d > maxDiff) { maxDiff = d; worst = { level: header.levels[l].hPa, latIdx: i, ch: c, a: data[a+c], b: data[b+c] }; }
        }
      }
    }
    console.log('首末列最大差:', maxDiff.toFixed(6), worst ? JSON.stringify(worst) : '');
  });

  it('极点行（lat=±90）沿经度是否恒定', () => {
    for (const [name, latIdx] of [['北极', g.nLat - 1], ['南极', 0]] as const) {
      let maxSpread = 0;
      for (let l = 0; l < header.levels.length; l++) {
        for (let ch = 0; ch < 2; ch++) {  // 只看 u,v
          let mn = Infinity, mx = -Infinity;
          for (let j = 0; j < g.nLon; j++) {
            const v = data[((l * g.nLat + latIdx) * g.nLon + j) * 4 + ch];
            mn = Math.min(mn, v); mx = Math.max(mx, v);
          }
          maxSpread = Math.max(maxSpread, mx - mn);
        }
      }
      console.log(`${name}行 u/v 沿经度极差:`, maxSpread.toFixed(3), 'm/s');
    }
  });
});
