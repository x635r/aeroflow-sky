#!/usr/bin/env node
/**
 * AeroFlow Sky — 静态数据烘焙
 * ---------------------------------------------------------------------------
 * 生成 public/data 下的三份衍生数据：
 *   1. land-50m.geojson      Natural Earth 1:50m 陆地多边形（简化后）
 *   2. airports.json         有定期航班的机场（按航线连接度排序）
 *   3. routes.json           高频城市对，用作演示预设
 *
 * 输入（缺失时自动下载，缓存在 .cache/src）：
 *   OpenFlights airports.dat / routes.dat
 *   Natural Earth ne_50m_land.geojson
 *
 * 用法：node scripts/bake_data.mjs [--refresh]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'data');
const cacheDir = path.join(root, '.cache', 'src');

const SRC = {
  airports: 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat',
  routes: 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat',
  land: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',
};

const refresh = process.argv.includes('--refresh');

async function ensure(name, url) {
  const dest = path.join(cacheDir, name);
  try {
    if (!refresh) {
      const st = await fs.stat(dest);
      if (st.size > 1024) return dest;
    }
  } catch {
    /* 未缓存 */
  }
  console.log(`[bake-data] 下载 ${name} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(dest, buf);
  console.log(`[bake-data]   ${(buf.length / 1e6).toFixed(2)} MB`);
  return dest;
}

/** OpenFlights 的 CSV 是带引号且内含逗号的朴素格式，手写解析即可 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function buildAirports() {
  const apPath = await ensure('airports.dat', SRC.airports);
  const rtPath = await ensure('routes.dat', SRC.routes);

  const apRaw = await fs.readFile(apPath, 'utf8');
  const byIata = new Map();
  for (const line of apRaw.split('\n')) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    // ID,Name,City,Country,IATA,ICAO,Lat,Lon,Alt,TZ,DST,TzDb,Type,Source
    const iata = (f[4] || '').trim();
    const lat = Number(f[6]);
    const lon = Number(f[7]);
    if (iata.length !== 3 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    byIata.set(iata, {
      iata,
      icao: (f[5] || '').trim(),
      name: f[1],
      city: f[2],
      country: f[3],
      lat,
      lon,
      tz: f[11],
    });
  }

  const rtRaw = await fs.readFile(rtPath, 'utf8');
  const degree = new Map();
  const pairs = new Map();
  for (const line of rtRaw.split('\n')) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    // Airline,AirlineID,Source,SourceID,Dest,DestID,Codeshare,Stops,Equipment
    const src = (f[2] || '').trim();
    const dst = (f[4] || '').trim();
    const stops = Number(f[7]);
    if (stops !== 0) continue;
    if (!byIata.has(src) || !byIata.has(dst)) continue;
    degree.set(src, (degree.get(src) || 0) + 1);
    degree.set(dst, (degree.get(dst) || 0) + 1);
    const key = src < dst ? `${src}-${dst}` : `${dst}-${src}`;
    const rec = pairs.get(key) || { a: src, b: dst, n: 0, airlines: new Set() };
    rec.n += 1;
    if (f[0]) rec.airlines.add(f[0].trim());
    pairs.set(key, rec);
  }

  // 只保留连接度靠前的机场，体积可控且覆盖主要枢纽
  const ranked = [...degree.entries()].sort((x, y) => y[1] - x[1]);
  const keep = new Set(ranked.slice(0, 520).map(([iata]) => iata));

  const airports = [...keep]
    .map((iata) => {
      const a = byIata.get(iata);
      return { ...a, degree: degree.get(iata) };
    })
    .sort((a, b) => b.degree - a.degree);

  const routeList = [...pairs.values()]
    .filter((p) => keep.has(p.a) && keep.has(p.b))
    .map((p) => ({ a: p.a, b: p.b, airlines: p.airlines.size, n: p.n }))
    .sort((x, y) => y.airlines * 10 + y.n - (x.airlines * 10 + x.n))
    .slice(0, 900);

  console.log(
    `[bake-data] 机场 ${airports.length} 个（原始 ${byIata.size}），航线对 ${routeList.length} 条`,
  );
  return { airports, routes: routeList };
}

/** Douglas-Peucker（经纬度平面近似，用于缩减多边形顶点数） */
function simplifyRing(pts, tol) {
  if (pts.length < 6) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [x0, y0] = pts[i0];
    const [x1, y1] = pts[i1];
    let maxD = -1;
    let idx = -1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1e-9;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = pts[i];
      const d = Math.abs(dy * (px - x0) - dx * (py - y0)) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

async function buildLand() {
  const landPath = await ensure('ne_50m_land.geojson', SRC.land);
  const gj = JSON.parse(await fs.readFile(landPath, 'utf8'));
  const tol = 0.045; // 度；约 5 km，视觉上看不出台阶

  const polys = [];
  let inVerts = 0;
  let outVerts = 0;

  const handleRing = (ring) => {
    inVerts += ring.length;
    // 去掉与首点重复的闭合点，简化后再补回
    const open = ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
    const s = simplifyRing(open, tol);
    outVerts += s.length;
    return s.map(([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]);
  };

  for (const feat of gj.features) {
    const g = feat.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      const rings = g.coordinates.map(handleRing);
      if (rings[0] && rings[0].length >= 3) polys.push(rings);
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        const rings = poly.map(handleRing);
        if (rings[0] && rings[0].length >= 3) polys.push(rings);
      }
    }
  }

  console.log(
    `[bake-data] 陆地多边形 ${polys.length} 个，顶点 ${inVerts} → ${outVerts}`,
  );
  return polys;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const { airports, routes } = await buildAirports();
  const land = await buildLand();

  await fs.writeFile(
    path.join(outDir, 'airports.json'),
    JSON.stringify({ source: 'OpenFlights airports.dat (ODbL)', airports }),
  );
  await fs.writeFile(
    path.join(outDir, 'routes.json'),
    JSON.stringify({ source: 'OpenFlights routes.dat (ODbL)', routes }),
  );
  await fs.writeFile(
    path.join(outDir, 'land-50m.json'),
    JSON.stringify({
      source: 'Natural Earth 1:50m land (public domain)',
      tol: 0.045,
      polygons: land,
    }),
  );

  const sizes = await Promise.all(
    ['airports.json', 'routes.json', 'land-50m.json'].map(async (f) => {
      const st = await fs.stat(path.join(outDir, f));
      return `${f} ${(st.size / 1024).toFixed(0)} KB`;
    }),
  );
  console.log(`[bake-data] 完成：${sizes.join(' · ')}`);
}

main().catch((e) => {
  console.error('[bake-data] 失败：', e);
  process.exit(1);
});
