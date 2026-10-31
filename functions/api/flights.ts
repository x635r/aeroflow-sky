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

type Pb = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

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

async function withCache(pb: Pb, key: string, fn: () => Promise<Response>): Promise<Response> {
  const cache = await caches.open('aeroflow-flights');
  const hit = await cache.match(key);
  if (hit) {
    const age = Date.now() - Number(hit.headers.get('x-fetched-at') ?? 0);
    if (age < CACHE_TTL * 1000) return hit;
  }
  const res = await fn();
  if (res.ok) {
    const clone = new Response(res.body, res);
    clone.headers.set('x-fetched-at', String(Date.now()));
    await cache.put(key, clone);
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
async function fromAdsbLol(): Promise<Normalized[]> {
  // 北大西洋 + 西欧的空域中心，半径 250 nm 覆盖主要跨洋走廊
  const url = 'https://api.adsb.lol/v2/lat/50/lon/-30/dist/250';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);
  const data = (await res.json()) as {
    ac?: Array<{
      flight?: string;
      lat?: number;
      lon?: number;
      alt_baro?: number | 'ground';
      gs?: number;
      track?: number;
      t?: string;
    }>;
  };
  const out: Normalized[] = [];
  for (const a of data.ac ?? []) {
    if (a.alt_baro === 'ground' || typeof a.alt_baro !== 'number') continue;
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
    out.push({
      callsign: (a.flight || '').trim(),
      lat: a.lat,
      lon: a.lon,
      // alt_baro 是英尺
      alt: a.alt_baro * 0.3048,
      gs: (a.gs ?? 0) * 0.514444,
      track: a.track ?? 0,
      type: a.t,
    });
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
  const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
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

  const res = await fetch(url, { headers });
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

  const attempt = async (
    name: 'opensky' | 'adsblol',
    fn: () => Promise<Normalized[]>,
  ): Promise<{ source: string; states: Normalized[] } | null> => {
    try {
      const states = await fn();
      if (!states.length) return null;
      // 只保留巡航高度（>7.6 km）并限制条数，减小下游负担
      const cruise = states.filter((s) => s.alt > 7600).slice(0, 60);
      return { source: name, states: cruise.length ? cruise : states.slice(0, 60) };
    } catch (e) {
      console.warn(`[flights] ${name} 失败:`, (e as Error).message);
      return null;
    }
  };

  const order: Array<'opensky' | 'adsblol'> =
    want === 'adsblol' ? ['adsblol', 'opensky'] : ['opensky', 'adsblol'];

  const key = new Request(`https://aeroflow.internal/flights?${order.join(',')}`, {
    method: 'GET',
  });

  return withCache(context.platform as unknown as Pb, key.url, async () => {
    for (const name of order) {
      const r =
        name === 'opensky'
          ? await attempt('opensky', () => fromOpenSky(env))
          : await attempt('adsblol', fromAdsbLol);
      if (r) return json({ source: r.source, fetchedAt: Date.now(), states: r.states });
    }
    return json({ source: 'unavailable', fetchedAt: Date.now(), states: [] }, 503);
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
