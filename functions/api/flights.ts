/**
 * Cloudflare Pages Function：ADS-B 代理
 * ---------------------------------------------------------------------------
 * 为什么需要它：
 *   OpenSky 与 adsb.lol 的响应都没有携带 `Access-Control-Allow-Origin`，
 *   浏览器端 fetch 会被 CORS 拦截；而 API 凭据与速率控制也不该暴露给前端。
 *   这一个函数把三件事收在一起：转发请求、缓存在边缘、统一成前端契约。
 *
 * 路由：GET /api/flights
 * 响应：{ source, fetchedAt, states: [{callsign, lat, lon, alt, gs, track, type}] }
 *
 * 部署：Cloudflare Pages 自动识别 functions/ 目录。无需额外配置；
 * 若配置了 OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET 环境变量，
 * 会使用 OAuth2 客户端凭据模式以获得更高的速率上限。
 */

type Env = {
  OPENSKY_CLIENT_ID?: string;
  OPENSKY_CLIENT_SECRET?: string;
};

type Normalized = {
  callsign: string;
  lat: number;
  lon: number;
  alt: number;
  gs: number;
  track: number;
  type?: string;
};

const CACHE_TTL = 15; // 秒；ADS-B 数据本身刷新也就这个量级
const CACHE_AEROFLOW = 'aeroflow-flights-v1'; // 改版本号可强制失效旧缓存
/** 上游超时：上游挂起时不能把整个 Function 拖到平台墙钟上限 */
const UPSTREAM_TIMEOUT_MS = 6000;

/**
 * 边缘缓存包装。
 *
 * 关键点：必须用 `res.clone()` 而不是 `new Response(res.body, res)`。
 * 后者与原响应**共享同一条 ReadableStream**，`cache.put()` 读取后
 * 原始 body 变成 "already read"，前端拿到的是一个无法 json() 的空响应，
 * 于是永远落到「代理不可用」分支、退回模拟数据。
 * `clone()` 内部会 tee 流，两个 body 都能独立读取。
 */
async function withCache(key: string, fn: () => Promise<Response>): Promise<Response> {
  const cache = await caches.open(CACHE_AEROFLOW);
  const hit = await cache.match(key);
  if (hit) {
    const age = Date.now() - Number(hit.headers.get('x-fetched-at') ?? 0);
    if (age < CACHE_TTL * 1000) return hit;
  }

  const res = await fn();
  // 对「成功但为空」也做短缓存（负缓存），否则每个客户端请求都会
  // 重新打两遍上游；上游在数据中心 IP 上本来就容易限流。
  if (res.ok || res.status === 503) {
    // clone 会 tee 出第二条流给缓存，原响应保持可读
    const forCache = res.clone();
    const tagged = new Response(forCache.body, {
      status: forCache.status,
      headers: new Headers(forCache.headers),
    });
    tagged.headers.set('x-fetched-at', String(Date.now()));
    // 缓存写入失败不应影响本次响应
    await cache.put(key, tagged).catch(() => {});
  }
  return res;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_TTL}`,
      'access-control-allow-origin': '*',
    },
  });
}

/** 从 adsb.lol 的 point 查询拿一片空域（免密钥、覆盖较好） */
/**
 * adsb.lol 的 point 查询一次只覆盖一个圆。
 * 单点 250nm 在低流量时段经常返回 0 架（实测 GIG 节点此刻就是 0），
 * 所以并发查多个跨洋走廊中心再合并去重。
 */
const ADSB_CENTERS: Array<{ lat: number; lon: number; dist: number }> = [
  { lat: 51, lon: -30, dist: 250 }, // 北大西洋
  { lat: 40, lon: -60, dist: 250 }, // 北美东岸出港
  { lat: 48, lon: 2, dist: 250 }, // 西欧
  { lat: 40, lon: -120, dist: 250 }, // 美西
  { lat: 35, lon: 140, dist: 250 }, // 日本
  { lat: 1, lon: 104, dist: 250 }, // 东南亚
];

async function fromAdsbLol(): Promise<Normalized[]> {
  const results = await Promise.allSettled(
    ADSB_CENTERS.map(async (c) => {
      const url = `https://api.adsb.lol/v2/lat/${c.lat}/lon/${c.lon}/dist/${c.dist}`;
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);
      return (await res.json()) as {
        ac?: Array<{
          hex?: string;
          flight?: string;
          lat?: number;
          lon?: number;
          alt_baro?: number | 'ground';
          gs?: number;
          track?: number;
          t?: string;
        }>;
      };
    }),
  );

  const seen = new Set<string>();
  const out: Normalized[] = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value.ac ?? []) {
      if (a.alt_baro === 'ground' || typeof a.alt_baro !== 'number') continue;
      if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
      // 跨圆重叠的去重键：优先 icao24，否则坐标
      const key = a.hex || `${a.lat.toFixed(3)},${a.lon.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        // 呼号缺失时用 icao24，保证每条记录有唯一标识
        callsign: (a.flight || '').trim() || a.hex || '',
        lat: a.lat,
        lon: a.lon,
        alt: a.alt_baro * 0.3048,
        gs: (a.gs ?? 0) * 0.514444,
        track: a.track ?? 0,
        type: a.t,
      });
    }
  }
  return out;
}

async function openskyToken(env: Env): Promise<string | null> {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.OPENSKY_CLIENT_ID,
    client_secret: env.OPENSKY_CLIENT_SECRET,
  });
  const res = await fetch(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string };
  return j.access_token ?? null;
}

/** OpenSky：北大西洋空域，需要鉴权时自动带 token */
async function fromOpenSky(env: Env): Promise<Normalized[]> {
  const url = 'https://opensky-network.org/api/states/all?lamin=38&lomin=-75&lamax=64&lomax=15';
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = await openskyToken(env);
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
  const data = (await res.json()) as { states?: Array<Array<unknown>> | null };
  const out: Normalized[] = [];
  for (const row of data.states ?? []) {
    const callsign = String(row[1] ?? '').trim();
    const lon = row[5] as number | null;
    const lat = row[6] as number | null;
    const alt = row[13] as number | null;
    const gs = row[9] as number | null;
    const track = row[10] as number | null;
    if (lat == null || lon == null || alt == null) continue;
    out.push({
      callsign,
      lat,
      lon,
      alt,
      gs: gs ?? 0,
      track: track ?? 0,
    });
  }
  return out;
}

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { env } = context;
  const url = new URL(context.request.url);
  const want = url.searchParams.get('source');
  const debug = url.searchParams.get('debug') === '1';

  // 诊断模式：直连各上游并回报原始结果，不走缓存。
  // 部署在不同区域时，上游可达性会变（数据中心 IP 常被限流），
  // 有这个模式才能区分「代码问题」和「网络问题」。
  if (debug) {
    const probe = async (name: string, fn: () => Promise<Normalized[]>) => {
      const t0 = Date.now();
      try {
        const states = await fn();
        return { upstream: name, ok: true, count: states.length, ms: Date.now() - t0 };
      } catch (e) {
        return {
          upstream: name,
          ok: false,
          error: (e as Error).message || String(e),
          ms: Date.now() - t0,
        };
      }
    };
    const results = [
      await probe('opensky', () => fromOpenSky(env)),
      await probe('adsblol', fromAdsbLol),
    ];
    return json({ debug: true, colo: context.request.cf?.colo ?? null, results }, 200);
  }

  const errors: Array<{ upstream: string; error: string }> = [];

  const attempt = async (
    name: 'opensky' | 'adsblol',
    fn: () => Promise<Normalized[]>,
  ): Promise<{ source: string; states: Normalized[] } | null> => {
    try {
      const states = await fn();
      if (!states.length) {
        errors.push({ upstream: name, error: '返回 0 架航空器（该空域当前无覆盖）' });
        return null;
      }
      const cruise = states.filter((s) => s.alt > 7600).slice(0, 60);
      return { source: name, states: cruise.length ? cruise : states.slice(0, 60) };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      errors.push({ upstream: name, error: msg });
      console.warn(`[flights] ${name} 失败:`, msg);
      return null;
    }
  };

  const order: Array<'opensky' | 'adsblol'> =
    want === 'adsblol' ? ['adsblol', 'opensky'] : ['opensky', 'adsblol'];

  const key = new Request(`https://aeroflow.internal/flights?${order.join(',')}`, {
    method: 'GET',
  });

  return withCache(key.url, async () => {
    for (const name of order) {
      const r =
        name === 'opensky'
          ? await attempt('opensky', () => fromOpenSky(env))
          : await attempt('adsblol', fromAdsbLol);
      if (r) return json({ source: r.source, fetchedAt: Date.now(), states: r.states });
    }
    return json(
      { source: 'unavailable', fetchedAt: Date.now(), states: [], errors },
      503,
    );
  });
};

export const onRequestOptions = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
