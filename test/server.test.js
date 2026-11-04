import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, rateLimiter, clientIp } from '../server.js';

// A stand-in for src/cellar.js: same methods, no network.
function fakeCellar() {
  const calls = [];
  return {
    calls,
    bucket: 'darkroom-test',
    publicBase: 'https://darkroom-test.cellar.example',
    publicOrigin: 'https://darkroom-test.cellar.example',
    prepare: async () => ['CreateBucket darkroom-test: created'],
    seed: async () => 0,
    sweep: async () => 0,
    ping: async () => true,
    rules: async () => ({ bucket: 'darkroom-test', cors: [], policy: null }),
    listPrints: async () => [],
    probes: async () => [],
    negativeLink: async (id) => (id.startsWith('0') ? { url: 'https://signed', expiresIn: 60 } : null),
    slip: async (type) => { calls.push(['slip', type]); return { key: 'darkroom/x.jpg', url: 'https://darkroom-test.cellar.example/', fields: {} }; },
    develop: async (key) => { calls.push(['develop', key]); return { status: 201, print: { key }, trace: [], appBytes: 16 }; },
  };
}

const env = { CELLAR_ADDON_HOST: 'cellar.example', CELLAR_ADDON_KEY_ID: 'k', CELLAR_ADDON_KEY_SECRET: 'never-shown-secret', APP_ID: 'app_test' };
let base;
let app;
let cellar;
const silent = { log() {}, error() {} };

before(async () => {
  cellar = fakeCellar();
  app = createApp({ env, cellar, log: silent });
  await app.boot();
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the page lets the browser reach Cellar, and only Cellar', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self' https:\/\/darkroom-test\.cellar\.example/);
  assert.match(csp, /img-src 'self' data: blob: https:\/\/darkroom-test\.cellar\.example/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const html = await res.text();
  assert.doesNotMatch(html, /\{\{BOOT\}\}/);
  assert.match(html, /"bucket":"darkroom-test"/);
  assert.doesNotMatch(html, /never-shown-secret/);
});

test('health and deep health', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const deep = await fetch(`${base}/health/deep`);
  assert.equal(deep.status, 200);
  assert.equal((await deep.json()).cellar, 'reachable');
});

test('a slip needs a valid type and size, and a same-origin caller', async () => {
  assert.equal((await post('/api/slips', { type: 'image/jpeg', size: 1000 })).status, 201);
  assert.equal((await post('/api/slips', { type: 'text/html', size: 1000 })).status, 400);
  assert.equal((await post('/api/slips', { type: 'image/jpeg', size: 6 * 1024 * 1024 })).status, 413);
  assert.equal((await post('/api/slips', { type: 'image/jpeg', size: 1 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/slips`, { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
  assert.deepEqual(cellar.calls.filter((c) => c[0] === 'slip'), [['slip', 'image/jpeg']]);
});

test('develop passes the key through, negatives are looked up by id', async () => {
  const res = await post('/api/develop', { key: 'darkroom/abc.jpg' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).appBytes, 16);
  assert.equal((await fetch(`${base}/api/negatives/0aaaaaaa-0000-4000-8000-000000000000`)).status, 200);
  assert.equal((await fetch(`${base}/api/negatives/1aaaaaaa-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/api/negatives/..%2F..`)).status, 404);
});

test('rate limit: twelve slips per window and per address', () => {
  const allow = rateLimiter(2, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 10), true);
  assert.equal(allow('a', 20), false);
  assert.equal(allow('b', 20), true);
  assert.equal(allow('a', 1500), true);
});

test('client address: the last X-Forwarded-For entry', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }, socket: {} }), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
});

test('without the add-on the app still starts and says what is missing', async () => {
  const bare = createApp({ env: {}, log: silent });
  await new Promise((resolve) => bare.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${bare.server.address().port}`;
  assert.equal((await fetch(`${url}/`)).status, 200);
  const deep = await fetch(`${url}/health/deep`);
  assert.equal(deep.status, 503);
  assert.match((await deep.json()).cellar, /CELLAR_ADDON_HOST/);
  bare.server.close();
});
