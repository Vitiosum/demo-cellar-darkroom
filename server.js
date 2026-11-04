// The Darkroom: browsers send photos straight to a Cellar bucket, this app only signs the slips.
// One Node.js server, no framework. The only dependency is the standard AWS SDK for JavaScript v3.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { cellarConfig, appOrigins, checkSlipRequest, MAX_BYTES, SLIP_SECONDS, MAX_PRINTS, SNIFF_BYTES } from './src/rules.js';
import { createCellar } from './src/cellar.js';
import { photogram } from './public/photogram.js';

const PUBLIC = join(import.meta.dirname, 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = new Set(['/cc-brand.css', '/darkroom.css', '/darkroom.js', '/photogram.js']);
const PLATFORM_VARS = ['CC_APP_NAME', 'APP_ID', 'INSTANCE_NUMBER', 'INSTANCE_TYPE', 'CC_PRETTY_INSTANCE_NAME', 'CC_COMMIT_ID', 'CC_DEPLOYMENT_ID'];
export const SEEDS = [122, 150, 59, 129, 17, 73]; // hung oldest first: 73 ends up first on the line

// A visitor may ask for 12 slips per 10 minutes (counted per instance).
export function rateLimiter(limit = 12, windowMs = 10 * 60_000) {
  const hits = new Map();
  return (ip, now = Date.now()) => {
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) { hits.set(ip, recent); return false; }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return true;
  };
}

// Behind the Clever Cloud load balancer, the last X-Forwarded-For entry is the address it saw.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.at(-1) || req.socket.remoteAddress || 'unknown';
}

async function readJson(req, limit = 2048) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const escapeScript = (data) => JSON.stringify(data).replaceAll('<', '\\u003c');

export function createApp({ env = process.env, cellar = undefined, origins = appOrigins(env), log = console } = {}) {
  const cfg = cellarConfig(env);
  const store = cellar ?? (cfg.ok ? createCellar(cfg, { origins }) : null);
  const state = { ready: false, problem: cfg.ok ? 'Preparing the bucket' : `Cellar not linked: missing ${cfg.missing.join(', ')}`, steps: [] };
  const allow = rateLimiter();
  const template = readFile(join(PUBLIC, 'index.html'), 'utf8');
  const platform = PLATFORM_VARS.map((name) => ({ name, value: env[name] ?? null }));

  const cellarOrigin = store?.publicOrigin ?? '';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: blob: ${cellarOrigin}`.trim(),
    `connect-src 'self' ${cellarOrigin}`.trim(), // the browser talks to Cellar directly
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');

  // Bucket, CORS and policy at boot, then the seed prints. Retried until Cellar answers.
  async function boot(attempt = 1) {
    if (!store) return;
    try {
      state.steps = await store.prepare();
      const seeded = await store.seed(SEEDS.map((s) => photogram(s)));
      if (seeded) state.steps.push(`Seed: ${seeded} photograms developed`);
      state.ready = true;
      state.problem = null;
      for (const s of state.steps) log.log(`[cellar] ${s}`);
      // Negatives nobody developed (a tab closed mid-way) are swept now, then every 10 minutes.
      await store.sweep().catch(() => 0);
      setInterval(() => store.sweep().catch(() => 0), 10 * 60_000).unref();
    } catch (err) {
      state.problem = `Cellar: ${err.message}`;
      log.error(`[cellar] boot attempt ${attempt} failed: ${err.name}: ${err.message}`);
      setTimeout(() => boot(attempt + 1), Math.min(30_000, 2000 * attempt)).unref();
    }
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', // presigned URLs never leak through a Referer header
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      ...headers,
    });
    res.end(body);
  }
  const json = (res, status, data, headers = {}) =>
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

  async function page() {
    const boot = {
      bucket: store?.bucket ?? null,
      publicBase: store?.publicBase ?? null,
      maxBytes: MAX_BYTES,
      slipSeconds: SLIP_SECONDS,
      maxPrints: MAX_PRINTS,
      sniffBytes: SNIFF_BYTES,
      problem: state.problem,
      platform,
    };
    return (await template).replace('{{BOOT}}', escapeScript(boot));
  }

  // POSTs come from the page itself: a browser on another site gets a 403.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://local');
    try {
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
        if (!state.ready) return json(res, 503, { error: state.problem });
        if (pathname === '/api/slips') {
          const ask = checkSlipRequest(await readJson(req));
          if (ask.error) return json(res, ask.status ?? 400, { error: ask.error });
          if (!allow(clientIp(req))) return json(res, 429, { error: 'Twelve slips per ten minutes: the darkroom needs a break' }, { 'Retry-After': '600' });
          return json(res, 201, await store.slip(ask.type));
        }
        if (pathname === '/api/develop') {
          const body = await readJson(req);
          const out = await store.develop(body?.key);
          return json(res, out.status, out.error ? { error: out.error, trace: out.trace ?? [] } : out);
        }
        return json(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET or POST' }, { Allow: 'GET, HEAD, POST' });

      if (pathname === '/health') return json(res, 200, { status: 'ok' });
      if (pathname === '/health/deep') {
        if (!store) return json(res, 503, { status: 'degraded', cellar: state.problem });
        const ok = await store.ping().catch((err) => err.name);
        return json(res, ok === true && state.ready ? 200 : 503, { status: ok === true && state.ready ? 'ok' : 'degraded', cellar: ok === true ? 'reachable' : ok, bucket: store.bucket, ready: state.ready });
      }
      if (pathname === '/') return send(res, 200, await page(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      if (STATIC.has(pathname)) {
        const body = await readFile(join(PUBLIC, pathname));
        return send(res, 200, body, { 'Content-Type': TYPES[extname(pathname)], 'Cache-Control': 'no-cache' });
      }
      if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (!state.ready) return json(res, 503, { error: state.problem });
      if (pathname === '/api/prints') return json(res, 200, { prints: await store.listPrints() });
      if (pathname === '/api/rules') return json(res, 200, { ...(await store.rules()), boot: state.steps });
      if (pathname === '/api/probes') return json(res, 200, { probes: await store.probes() });
      const neg = /^\/api\/negatives\/([0-9a-f-]{36})$/.exec(pathname);
      if (neg) {
        const link = await store.negativeLink(neg[1]);
        return link ? json(res, 200, link) : json(res, 404, { error: 'No such negative' });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      log.error(err);
      return json(res, 502, { error: `Cellar: ${err.name}` });
    }
  });

  return { server, boot, state };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const port = Number(process.env.PORT) || 8080;
  const { server, boot } = createApp();
  server.listen(port, '0.0.0.0', () => {
    console.log(`The Darkroom listening on 0.0.0.0:${port}`);
    console.log(`Browsers may upload from: ${appOrigins().join(', ')}`);
    boot();
  });
  // On restart, Clever Cloud starts the new instance, then stops this one.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
