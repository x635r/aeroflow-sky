import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeHalf } from '../src/data/windField';
import type { WindField, WindHeader } from '../src/data/windField';
import { planGreatCircle, planRhumb, planWindOptimal, comparePlans } from '../src/sim/routeEngine';
import type { PlanContext } from '../src/sim/routeEngine';
import { aircraftById, solveWindTriangle } from '../src/core/atmos';

const dataDir = path.join(__dirname, '..', 'public', 'data');
const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'wind-manifest.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dataDir, manifest.file));
const hdrLen = buf.readUInt32LE(4);
const header = JSON.parse(buf.subarray(8, 8 + hdrLen).toString('utf8')) as WindHeader;
const payload = buf.subarray(8 + hdrLen);
const u16 = new Uint16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
const field: WindField = { header, data: decodeHalf(u16), grid: header.grid, levels: header.levels.map(l=>l.hPa), steps: header.steps.map(s=>s.hour), stridePerLevel: header.grid.nLat*header.grid.nLon*4, stepTimestamps: header.steps.map(s=>Date.parse(s.validTime)) };
const ctx: PlanContext = { field, pressureHpa: 250, stepPos: 0, aircraft: aircraftById('b77w'), mach: 0.84 };

const jfk = { lat: 40.6413, lon: -73.7781 };
const lhr = { lat: 51.47, lon: -0.4614 };

describe('AUDIT', () => {
  it('A: rhumb line correctness', () => {
    const f = planRhumb(ctx, jfk, lhr);
    const r = planRhumb(ctx, lhr, jfk);
    console.log('rhumb JFK->LHR km', (f.distance/1000).toFixed(1));
    console.log('rhumb LHR->JFK km', (r.distance/1000).toFixed(1));
    console.log('  symmetric?', Math.abs(f.distance-r.distance) < 1000);
    console.log('  true rhumb ~5758 km, got', (f.distance/1000).toFixed(1));
    // 最后一段长度
    const last = f.points[f.points.length-1].distance - f.points[f.points.length-2].distance;
    const avg = f.distance / f.points.length;
    console.log('  last leg km', (last/1000).toFixed(2), 'avg leg km', (avg/1000).toFixed(2));
  });

  it('B: integrateLegs first point distance', () => {
    const gc = planGreatCircle(ctx, jfk, lhr);
    console.log('points[0].distance km =', (gc.points[0].distance/1000).toFixed(2), '(should be 0)');
    // 独立重算时长
    let t = 0;
    for (let i=0;i<gc.points.length-1;i++){
      const d = gc.points[i+1].distance - gc.points[i].distance;
      t += d / Math.max((gc.points[i].groundSpeed+gc.points[i+1].groundSpeed)/2, 1);
    }
    console.log('reported duration min', (gc.duration/60).toFixed(2), 'recomputed', (t/60).toFixed(2));
  });

  it('C: sidewind > TAS infeasibility', () => {
    const r1 = solveWindTriangle(90, 100, { u: 50, v: 140 });
    console.log('sidewind 140 vs TAS 100 ->', JSON.stringify(r1));
    const r2 = solveWindTriangle(90, 150, { u: 60, v: 200 });
    console.log('sidewind 200 vs TAS 150 ->', JSON.stringify(r2));
  });

  it('D: extraDistance on fallback + reverse guard', () => {
    const cmp = comparePlans(ctx, jfk, lhr);
    console.log('gc.extraDistance km', (cmp.gc.extraDistance/1000).toFixed(1), '(should be 0)');
    console.log('opt.extraDistance km', (cmp.optimal.extraDistance/1000).toFixed(1));
    console.log('reverse vs its own gc: reverse dur', (cmp.reverse.duration/60).toFixed(2), 'gc dur', (cmp.gc.duration/60).toFixed(2));
  });

  it('E: corridor 0 should equal great circle', () => {
    const gc = planGreatCircle(ctx, jfk, lhr);
    const dp = planWindOptimal(ctx, jfk, lhr, { corridorKm: 0 });
    console.log('corridor0 dur', (dp.duration/60).toFixed(2), 'gc dur', (gc.duration/60).toFixed(2), 'diff min', ((dp.duration-gc.duration)/60).toFixed(3));
  });

  it('F: even offsets loses center', () => {
    for (const off of [19, 20, 22]) {
      const dp = planWindOptimal(ctx, jfk, lhr, { corridorKm: 680, offsets: off });
      console.log('offsets', off, 'dpDist km', (dp.distance/1000).toFixed(1));
    }
  });
});
