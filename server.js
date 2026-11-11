// Monitor de la red eléctrica de España — servidor
// Sirve la web estática y hace de proxy con caché hacia la API pública REData de Red Eléctrica
// (https://apidatos.ree.es). Sin dependencias: requiere Node 18+.
//   node server.js        → http://localhost:8787

import http from 'node:http';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const REE = 'https://apidatos.ree.es/es/datos/';
const TZ = 'Europe/Madrid';

// ---------- Fechas en hora peninsular ----------
function madridNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= '2015-01-01' && !Number.isNaN(Date.parse(s));
// "2026-11-11T13:45:00.000+01:00" → minuto del día (hora local peninsular)
const minuteOf = dt => Number(dt.slice(11, 13)) * 60 + Number(dt.slice(14, 16));

// ---------- Caché + peticiones a REData ----------
const cache = new Map();     // key → { t, ttl, data }
const inflight = new Map();  // key → Promise
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function reeFetch(path) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(REE + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`Respuesta no JSON (${r.status})`); }
      if (j.errors) throw new Error(j.errors.map(e => e.detail).join('; '));
      return j;
    } catch (e) { lastErr = e; await sleep(700 * (i + 1)); }
  }
  throw lastErr;
}

// Cachea el resultado de fn() bajo key durante ttl segundos; si falla, devuelve el último bueno.
// Con swr=true, si el dato caducó se sirve el anterior al momento y se refresca en segundo plano.
const CACHE_MAX = 400;
async function cached(key, ttl, fn, swr = false) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < c.ttl * 1000) return c.data;
  if (inflight.has(key)) return c && swr ? c.data : inflight.get(key);
  const p = (async () => {
    try {
      const data = await fn();
      cache.delete(key);
      cache.set(key, { t: Date.now(), ttl, data });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // el más antiguo
      return data;
    } catch (e) {
      if (c) return { ...c.data, stale: true };
      throw e;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  if (c && swr) { p.catch(() => {}); return c.data; }
  return p;
}

// Normaliza una respuesta REData plana: { updated, series: [{ title, type, color, values:[{dt,v}] }] }
function flat(j) {
  const series = [];
  for (const s of j.included || []) {
    const a = s.attributes;
    if (a.content) {
      for (const c of a.content) {
        const b = c.attributes;
        series.push({ group: a.title, title: b.title, type: b.type || a.title, color: b.color, values: (b.values || []).map(x => ({ dt: x.datetime, v: x.value })) });
      }
    } else {
      series.push({ title: a.title, type: a.type, color: a.color, values: (a.values || []).map(x => ({ dt: x.datetime, v: x.value })) });
    }
  }
  return { updated: j.data?.attributes?.['last-update'] || null, series };
}

// ---------- Endpoints de datos ----------
const SYSTEMS = [
  { id: 8741, key: 'peninsular', name: 'Península' },
  { id: 8742, key: 'canarias', name: 'Canarias' },
  { id: 8743, key: 'baleares', name: 'Baleares' },
  { id: 8744, key: 'ceuta', name: 'Ceuta' },
  { id: 8745, key: 'melilla', name: 'Melilla' },
];
// id REE → código INE de comunidad (coincide con es-atlas)
const CCAA = [
  { id: 4, ine: '01', name: 'Andalucía' }, { id: 5, ine: '02', name: 'Aragón' },
  { id: 11, ine: '03', name: 'Asturias' }, { id: 8743, ine: '04', name: 'Baleares' },
  { id: 8742, ine: '05', name: 'Canarias' }, { id: 6, ine: '06', name: 'Cantabria' },
  { id: 8, ine: '07', name: 'Castilla y León' }, { id: 7, ine: '08', name: 'Castilla-La Mancha' },
  { id: 9, ine: '09', name: 'Cataluña' }, { id: 15, ine: '10', name: 'C. Valenciana' },
  { id: 16, ine: '11', name: 'Extremadura' }, { id: 17, ine: '12', name: 'Galicia' },
  { id: 13, ine: '13', name: 'Madrid' }, { id: 21, ine: '14', name: 'Murcia' },
  { id: 14, ine: '15', name: 'Navarra' }, { id: 10, ine: '16', name: 'País Vasco' },
  { id: 20, ine: '17', name: 'La Rioja' }, { id: 8744, ine: '18', name: 'Ceuta' },
  { id: 8745, ine: '19', name: 'Melilla' },
];

async function realtime(date) {
  const now = madridNow();
  const isToday = date === now.date;
  if (date > now.date) throw new Error('Fecha futura');
  const recent = date >= addDays(now.date, -2);
  // REData cachea por URL hasta 24 h. Para hoy usamos un end_date único por segundo
  // (mañana a la hora actual) y así obtenemos siempre el último dato publicado.
  const end = isToday ? `${addDays(date, 1)}T${now.time}` : `${date}T23:59`;
  return cached(`rt:${date}`, isToday ? 45 : recent ? 600 : 21600, async () => {
    const j = flat(await reeFetch(`demanda/demanda-tiempo-real?start_date=${date}T00:00&end_date=${end}&time_trunc=hour`));
    const pick = t => (j.series.find(s => s.title === t)?.values || [])
      .filter(x => x.dt.startsWith(date)).map(x => ({ m: minuteOf(x.dt), v: x.v }));
    return { date, updated: j.updated, fetched: new Date().toISOString(), real: pick('Real'), prevista: pick('Prevista'), programada: pick('Programada') };
  });
}

async function prices(date) {
  return cached(`pr:${date}`, 900, async () => {
    const j = flat(await reeFetch(`mercados/precios-mercados-tiempo-real?start_date=${date}T00:00&end_date=${date}T23:59&time_trunc=hour`));
    const pick = t => (j.series.find(s => s.title.startsWith(t))?.values || [])
      .filter(x => x.dt.startsWith(date)).map(x => ({ m: minuteOf(x.dt), v: x.v }));
    return { date, updated: j.updated, pvpc: pick('PVPC'), spot: pick('Precio mercado spot') };
  });
}

async function mix(date) {
  const start = addDays(date, -29);
  return cached(`mix:${date}`, 1800, async () => {
    const g = flat(await reeFetch(`generacion/estructura-generacion?start_date=${start}T00:00&end_date=${date}T23:59&time_trunc=day`));
    let co2 = null;
    try { co2 = flat(await reeFetch(`generacion/no-renovables-detalle-emisiones-CO2?start_date=${start}T00:00&end_date=${date}T23:59&time_trunc=day`)); } catch {}
    const day = x => x.dt.slice(0, 10);
    return {
      updated: g.updated,
      techs: g.series.filter(s => s.title !== 'Generación total').map(s => ({
        title: s.title, type: s.type, color: s.color,
        values: s.values.map(x => ({ d: day(x), v: x.v })),
      })),
      total: (g.series.find(s => s.title === 'Generación total')?.values || []).map(x => ({ d: day(x), v: x.v })),
      co2: (co2?.series.find(s => s.title === 'tCO2 eq./MWh')?.values || []).map(x => ({ d: day(x), v: x.v })),
      co2total: (co2?.series.find(s => s.title.startsWith('Total tCO2'))?.values || []).map(x => ({ d: day(x), v: x.v })),
    };
  });
}

async function systems() {
  const now = madridNow();
  const start = addDays(now.date, -60);
  return cached('systems', 3600, async () => {
    const out = [];
    for (const s of SYSTEMS) {
      try {
        const j = flat(await reeFetch(`demanda/evolucion?start_date=${start}T00:00&end_date=${now.date}T23:59&time_trunc=day&geo_trunc=electric_system&geo_limit=${s.key}&geo_ids=${s.id}`));
        out.push({ ...s, values: (j.series[0]?.values || []).map(x => ({ d: x.dt.slice(0, 10), v: x.v })) });
      } catch (e) { out.push({ ...s, values: [], error: e.message }); }
      await sleep(250);
    }
    return { systems: out };
  }, true);
}

async function national() {
  const now = madridNow();
  return cached('national', 10800, async () => {
    // Dos tramos de un año para poder comparar con el año anterior
    const a = addDays(now.date, -365), b = addDays(now.date, -730);
    const j1 = flat(await reeFetch(`demanda/evolucion?start_date=${a}T00:00&end_date=${now.date}T23:59&time_trunc=day`));
    let j2 = { series: [] };
    try { j2 = flat(await reeFetch(`demanda/evolucion?start_date=${b}T00:00&end_date=${addDays(a, -1)}T23:59&time_trunc=day`)); } catch {}
    const byDay = new Map();
    for (const x of [...(j2.series[0]?.values || []), ...(j1.series[0]?.values || [])]) byDay.set(x.dt.slice(0, 10), x.v);
    return { updated: j1.updated, values: [...byDay].sort().map(([d, v]) => ({ d, v })) };
  }, true);
}

async function regions() {
  return cached('regions', 43200, async () => {
    const now = madridNow();
    const start = addDays(now.date.slice(0, 7) + '-01', -365).slice(0, 7) + '-01';
    const out = [];
    for (const r of CCAA) {
      try {
        const j = flat(await reeFetch(`balance/balance-electrico?start_date=${start}T00:00&end_date=${now.date}T23:59&time_trunc=month&geo_trunc=electric_system&geo_limit=ccaa&geo_ids=${r.id}`));
        const techs = j.series.filter(s => (s.group === 'Renovable' || s.group === 'No-Renovable') && !s.title.startsWith('Generación'))
          .map(s => ({ title: s.title, group: s.group, color: s.color, values: s.values.map(x => ({ m: x.dt.slice(0, 7), v: x.v })) }));
        out.push({ ...r, techs });
      } catch (e) { out.push({ ...r, techs: [], error: e.message }); }
      await sleep(300);
    }
    return { regions: out };
  }, true);
}

async function ire() {
  const now = madridNow();
  // La API limita las consultas mensuales a un año: pedimos 3 tramos y los unimos
  const y = Number(now.date.slice(0, 4)), mo = now.date.slice(5, 7);
  const ranges = [2, 1, 0].map(k => [`${y - k - 1}-${mo}-01`, k === 0 ? now.date : addDays(`${y - k}-${mo}-01`, -1)]);
  return cached('ire', 43200, async () => {
    const out = {};
    for (const k of ['general', 'industria', 'servicios']) {
      const merged = new Map();
      for (const [a, b] of ranges) {
        try {
          const j = flat(await reeFetch(`demanda/ire-${k}?start_date=${a}T00:00&end_date=${b}T23:59&time_trunc=month`));
          for (const s of j.series) {
            const m = merged.get(s.title) || new Map();
            for (const x of s.values) m.set(x.dt.slice(0, 7), x.v);
            merged.set(s.title, m);
          }
        } catch {}
        await sleep(200);
      }
      out[k] = [...merged].map(([title, m]) => ({ title, values: [...m].sort().map(([mm, v]) => ({ m: mm, v })) }));
    }
    return out;
  }, true);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join('; '),
};

function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...SECURITY, ...extra };
  const ae = req.headers['accept-encoding'] || '';
  if (buf.length > 1024 && COMPRESSIBLE.test(type)) {
    if (/\bbr\b/.test(ae)) { buf = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }); headers['Content-Encoding'] = 'br'; }
    else if (/\bgzip\b/.test(ae)) { buf = zlib.gzipSync(buf, { level: 6 }); headers['Content-Encoding'] = 'gzip'; }
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// Límite sencillo de peticiones a la API por IP (ventana de 1 minuto)
const RATE = Number(process.env.RATE_LIMIT || 120);
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
function clientIp(req) {
  const xf = process.env.TRUST_PROXY !== '0' && req.headers['x-forwarded-for'];
  return (xf ? xf.split(',')[0] : req.socket.remoteAddress || '').trim();
}

const routes = {
  '/api/now': () => madridNow(),
  '/api/realtime': q => realtime(validDate(q.get('date')) ? q.get('date') : madridNow().date),
  '/api/prices': q => prices(validDate(q.get('date')) ? q.get('date') : madridNow().date),
  '/api/mix': q => mix(validDate(q.get('date')) ? q.get('date') : madridNow().date),
  '/api/systems': () => systems(),
  '/api/national': () => national(),
  '/api/regions': () => regions(),
  '/api/ire': () => ire(),
};

// Ficheros estáticos en memoria (son pocos y pequeños)
const files = new Map();
async function staticFile(p) {
  if (files.has(p)) return files.get(p);
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT + '/') && file !== ROOT) return null;
  try {
    const f = { body: await readFile(file), type: MIME[extname(file)] || 'application/octet-stream' };
    if (process.env.NODE_ENV === 'production') files.set(p, f);
    return f;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Método no permitido', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(req, res, 400, 'Petición no válida', 'text/plain; charset=utf-8'); }
  if (url.pathname === '/healthz') return send(req, res, 200, { ok: true, uptime: Math.round(process.uptime()), cached: cache.size });
  if (routes[url.pathname]) {
    const ip = clientIp(req);
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > RATE) return send(req, res, 429, { error: 'Demasiadas peticiones, espera un minuto.' }, undefined, { 'Retry-After': '60' });
    try { send(req, res, 200, await routes[url.pathname](url.searchParams), undefined, { 'Cache-Control': 'public, max-age=20' }); }
    catch (e) { send(req, res, 502, { error: e.message || 'Error' }); }
    return;
  }
  let p;
  try { p = normalize(decodeURIComponent(url.pathname)); } catch { return send(req, res, 400, 'Ruta no válida', 'text/plain; charset=utf-8'); }
  if (p === '/' || p === '\\') p = '/index.html';
  const f = await staticFile(p);
  if (!f) return send(req, res, 404, 'No encontrado', 'text/plain; charset=utf-8');
  send(req, res, 200, f.body, f.type, { 'Cache-Control': f.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' });
});

server.listen(PORT, HOST, () => {
  console.log(`Monitor de la red eléctrica → http://localhost:${PORT}`);
  warm();
  // Mantiene calientes los datos lentos para que ningún visitante tenga que esperar
  setInterval(warm, 30 * 60 * 1000).unref();
});

function warm() {
  national().catch(() => {});
  systems().catch(() => {})
    .then(() => regions().catch(() => {}))
    .then(() => ire().catch(() => {}));
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
