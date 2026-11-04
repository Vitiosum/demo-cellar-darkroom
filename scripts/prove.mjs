// Prove the whole chain against a running Darkroom, from the outside:
//   node scripts/prove.mjs https://app-xxxx.cleverapps.io
// It does what a browser does (CORS preflight, multipart POST to Cellar), then asks Cellar directly.
// It hangs one print on the line (the fixture photogram) and leaves no orphan negative.
import { readFile } from 'node:fs/promises';

const base = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');
const origin = new URL(base).origin;
const photo = await readFile(new URL('../test/fixtures/photogram.jpg', import.meta.url));
const results = [];

function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` · ${detail}` : ''}`);
}
async function api(path, body) {
  const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function postToCellar(slip, file, type, from = origin) {
  const form = new FormData();
  for (const [k, v] of Object.entries(slip.fields)) form.append(k, k === 'Content-Type' && type ? type : v);
  form.append('file', new Blob([file]));
  const res = await fetch(slip.url, { method: 'POST', body: form, headers: { Origin: from } });
  const text = await res.text();
  return { status: res.status, code: /<Code>([^<]+)<\/Code>/.exec(text)?.[1], acao: res.headers.get('access-control-allow-origin') };
}
const preflight = async (url, from) => {
  const res = await fetch(url, { method: 'OPTIONS', headers: { Origin: from, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  return { status: res.status, acao: res.headers.get('access-control-allow-origin') };
};

console.log(`The Darkroom at ${base}\n`);
const deep = await api('/health/deep');
check('Deep health: Cellar reachable, bucket ready', deep.status === 200, `${deep.status} ${deep.data.bucket ?? deep.data.cellar}`);

const rules = await api('/api/rules');
const stmt = rules.data.policy?.Statement?.[0];
check('Bucket policy read back: anonymous GetObject on prints/* only', rules.data.policy?.Statement?.length === 1 && stmt.Principal === '*' && stmt.Resource?.[0]?.endsWith('/prints/*'), stmt?.Resource?.[0]);
check('CORS read back: POST allowed from this app', rules.data.cors?.some((r) => r.AllowedOrigins.includes(origin) && r.AllowedMethods.includes('POST')), rules.data.cors?.[0]?.AllowedOrigins?.join(', '));

const slip = await api('/api/slips', { type: 'image/jpeg', size: photo.length });
check('Slip signed by the app (presigned POST)', slip.status === 201 && Boolean(slip.data.fields?.Policy), `${slip.status} ${slip.data.key} → ${slip.data.url}`);

const good = await preflight(slip.data.url, origin);
check('CORS preflight from the app origin: allowed by Cellar', good.acao === origin, `${good.status} Access-Control-Allow-Origin: ${good.acao}`);
const evil = await preflight(slip.data.url, 'https://evil.example');
check('CORS preflight from another origin: refused by Cellar', !evil.acao, `${evil.status} Access-Control-Allow-Origin: ${evil.acao ?? 'none'}`);

const sent = await postToCellar(slip.data, photo);
check(`Upload straight to Cellar (${photo.length} bytes, the app is not in the path)`, sent.status === 201, `${sent.status}`);

const dev = await api('/api/develop', { key: slip.data.key });
check('Development: 16 bytes read by the app, CopyObject inside Cellar', dev.status === 201 && dev.data.appBytes === 16, dev.data.trace?.map((t) => t.call.split(' ')[0]).join(' → '));

const print = dev.data.print;
if (print) {
  const pub = await fetch(print.url);
  check('Anonymous GET on the print: served by Cellar', pub.status === 200 && pub.headers.get('content-type') === 'image/jpeg', `${pub.status} ${pub.headers.get('content-type')} ${pub.headers.get('content-length')} bytes`);
  const neg = await fetch(print.negativeUrl);
  const negText = await neg.text();
  check('Anonymous GET on the negative: refused by Cellar', neg.status === 403, `${neg.status} ${/<Code>([^<]+)/.exec(negText)?.[1] ?? ''}`);
  const link = await api(`/api/negatives/${print.id}`);
  const signed = await fetch(link.data.url);
  check('Presigned GET on the negative: allowed for 60 s', signed.status === 200, `${signed.status}`);
}

const big = await api('/api/slips', { type: 'image/jpeg', size: 5 * 1024 * 1024 });
const tooBig = await postToCellar(big.data, Buffer.alloc(6 * 1024 * 1024));
check('6 MB on a 5 MB slip: refused by Cellar', tooBig.status === 400, `${tooBig.status} ${tooBig.code ?? ''} · CORS header on the error: ${tooBig.acao ?? 'none'}`);
const html = await api('/api/slips', { type: 'image/jpeg', size: 32 });
const wrong = await postToCellar(html.data, Buffer.from('<h1>not a photo</h1>'), 'text/html');
check('text/html on an image/jpeg slip: refused by Cellar', wrong.status === 403, `${wrong.status} ${wrong.code ?? ''}`);
const cross = await fetch(`${base}/api/slips`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"type":"image/jpeg","size":1}' });
check('Slip asked from another site: refused by the app', cross.status === 403, `${cross.status}`);

const probes = await api('/api/probes');
check('The page\'s own probes agree', probes.data.probes?.length === 3 && probes.data.probes.every((p) => p.ok), probes.data.probes?.map((p) => p.status).join(' / '));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
