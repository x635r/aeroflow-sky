import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeHalf, sampleWind } from '../src/data/windField';
import type { WindField, WindHeader } from '../src/data/windField';
import { comparePlans, planWindOptimal } from '../src/sim/routeEngine';
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
const ctx: PlanContext = { field, pressureHpa: 250, stepPos: 0, aircraft: aircraftById('b77w'), mach: 0.84 };

describe('性能', () => {
  it('sampleWind 吞吐', () => {
    const N = 200000;
    const opts = { levelPos: 1, stepPos: 0 };
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const lat = -80 + (i % 160);
      const lon = -180 + ((i * 7) % 360);
      acc += sampleWind(field, lat, lon, opts).speed;
    }
    const ms = performance.now() - t0;
    console.log(`${N} 次采样 ${ms.toFixed(0)}ms → ${(N/ms*1000/1e6).toFixed(2)}M/s, 累加=${acc.toFixed(0)}`);
    expect(ms).toBeLessThan(2000);
  });

  it('单次 DP 推演耗时', () => {
    const t0 = performance.now();
    planWindOptimal(ctx, { lat: 40.64, lon: -73.78 }, { lat: 51.47, lon: -0.46 });
    const ms = performance.now() - t0;
    console.log(`单次 DP: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(400);
  });

  it('完整对比耗时', () => {
    const t0 = performance.now();
    comparePlans(ctx, { lat: 40.64, lon: -73.78 }, { lat: 51.47, lon: -0.46 });
    const ms = performance.now() - t0;
    console.log(`完整对比（4 次推演）: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(900);
  });
});
