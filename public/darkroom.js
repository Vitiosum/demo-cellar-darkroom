// The Darkroom, in the browser: get a slip from the app, send the file to Cellar yourself,
// ask the app to develop it, then hang the print. Plain JavaScript, no build step.
import { photogram, WIDTH, HEIGHT } from './photogram.js';

const boot = JSON.parse(document.getElementById('boot').textContent);
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const short = (url) => url.replace(/^https?:\/\//, '').replace(/(\/[^/]+\/)([0-9a-f]{8})[0-9a-f-]{28}/, '$1$2…');

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// A multipart POST straight to Cellar, with upload progress. XHR, because fetch has no upload progress.
function postToCellar(slip, file, { contentType, onProgress } = {}) {
  return new Promise((resolve) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(slip.fields)) form.append(k, k === 'Content-Type' && contentType ? contentType : v);
    form.append('file', file); // the file goes last: S3 ignores fields after it
    const xhr = new XMLHttpRequest();
    xhr.open('POST', slip.url);
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = xhr.responseText || '';
      resolve({
        status: xhr.status,
        code: /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? null,
        etag: (/<ETag>"?([^<"]+)"?<\/ETag>/.exec(body)?.[1]) ?? xhr.getResponseHeader('ETag')?.replaceAll('"', '') ?? null,
      });
    };
    xhr.onerror = () => resolve({ status: 0, code: 'NetworkError', etag: null });
    xhr.send(form);
  });
}

/* ---------- Platform panel and health ---------- */
function renderPlatform() {
  $('#platformVars').innerHTML = boot.platform.map(({ name, value }) =>
    `<div><dt>${esc(name)}</dt><dd class="${value ? '' : 'is-empty'}">${esc(value ?? 'not set')}</dd></div>`).join('');
}
async function checkHealth() {
  const pill = $('#deepPill');
  try {
    const res = await fetch('/health/deep');
    const data = await res.json();
    $('#deepText').textContent = res.ok ? `Cellar reachable · ${data.bucket}` : `Cellar: ${data.cellar ?? 'not ready'}`;
    pill.classList.toggle('is-bad', !res.ok);
  } catch {
    $('#deepText').textContent = 'Health check failed';
    pill.classList.add('is-bad');
  }
}

/* ---------- The drying line ---------- */
let prints = [];
const tilt = (id) => ((parseInt(id.slice(0, 4), 16) % 7) - 3) * 0.6;
function caption(p) {
  const d = new Date(p.modified);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return [`${day} · ${time}`, bytes(p.size)];
}
function printEl(p, isNew = false) {
  const el = document.createElement('article');
  el.className = `print${isNew ? ' is-new' : ''}`;
  el.style.setProperty('--tilt', `${tilt(p.id)}deg`);
  const [left, right] = caption(p);
  el.innerHTML = `<span class="print__peg" aria-hidden="true"></span>
    <button class="print__btn" type="button" aria-label="Print developed ${esc(left)}, open details">
      <img class="print__img" src="${esc(p.url)}" alt="" loading="${isNew ? 'eager' : 'lazy'}" decoding="async" width="400" height="500">
      <span class="print__cap"><span>${esc(left)}</span><span>${esc(right)}</span></span>
    </button>`;
  $('.print__btn', el).addEventListener('click', () => openViewer(p));
  return el;
}
function renderLine() {
  const line = $('#line');
  line.replaceChildren(...prints.map((p) => printEl(p)));
  if (!prints.length) line.innerHTML = '<p class="line__empty">The line is empty. Expose the first print.</p>';
  $('#printCount').textContent = `${prints.length} of ${boot.maxPrints} prints`;
}
async function loadPrints() {
  try {
    ({ prints } = await api('/api/prints'));
    renderLine();
  } catch (err) {
    $('#line').innerHTML = `<p class="line__empty">${esc(err.message)}</p>`;
  }
}

/* ---------- The print viewer ---------- */
let countdown;
function openViewer(p) {
  const v = $('#viewer');
  $('#viewerImg').src = p.url;
  $('#viewerTitle').textContent = `Print ${p.id.slice(0, 8)}`;
  const facts = [
    ['Print', p.key], ['Public URL', p.url], ['Size', `${bytes(p.size)} (${p.size.toLocaleString('en')} bytes)`],
    ['Type', p.type], ['ETag', p.etag ?? '–'], ['Developed', new Date(p.modified).toLocaleString('en-GB')], ['Negative', p.negative],
  ];
  $('#viewerFacts').innerHTML = facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
  $('#openPrint').href = p.url;
  $('#openNegative').href = p.negativeUrl;
  const sign = $('#signNegative');
  clearInterval(countdown);
  sign.replaceWith(sign.cloneNode(true));
  const fresh = $('#signNegative');
  fresh.textContent = 'Open the negative, presigned 60 s';
  fresh.addEventListener('click', async () => {
    fresh.disabled = true;
    try {
      const link = await api(`/api/negatives/${p.id}`);
      const a = document.createElement('a');
      a.className = 'cc-btn cc-btn--sm cc-btn--gradient';
      a.id = 'signNegative';
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      let left = link.expiresIn;
      const tick = () => {
        a.textContent = left > 0 ? `Open the signed URL · valid ${left} s` : 'Signature expired: Cellar now says 403';
        left -= 1;
        if (left < -1) clearInterval(countdown);
      };
      tick();
      countdown = setInterval(tick, 1000);
      fresh.replaceWith(a);
    } catch (err) {
      fresh.textContent = err.message;
    }
  });
  v.showModal();
}
$('#viewer').addEventListener('close', () => clearInterval(countdown));

/* ---------- The enlarger: one upload, four steps ---------- */
const steps = Object.fromEntries([...document.querySelectorAll('.step')].map((el) => [el.dataset.step, el]));
const actors = Object.fromEntries([...document.querySelectorAll('.actor')].map((el) => [el.dataset.actor, el]));
let busy = false;

function setStep(name, cls, html) {
  const el = steps[name];
  el.classList.remove('is-active', 'is-done', 'is-failed');
  if (cls) el.classList.add(cls);
  if (html !== undefined) $('[data-out]', el).innerHTML = html;
}
function setActors(...names) {
  for (const [n, el] of Object.entries(actors)) el.classList.toggle('is-active', names.includes(n));
}
function setBusy(on, label) {
  busy = on;
  $('#safelight').classList.toggle('is-on', on);
  $('#runState').textContent = label;
  $('#drawBtn').disabled = on;
  $('label[for="fileInput"]').classList.toggle('is-disabled', on);
}

function showSlip(slip) {
  const policy = JSON.parse(atob(slip.fields.Policy));
  const mask = (v) => String(v).replace(/^([A-Za-z0-9]{4})[A-Za-z0-9]+\//, '$1…/');
  const lines = [`<li><b>expiration</b> ${esc(policy.expiration)}</li>`];
  for (const c of policy.conditions) {
    if (Array.isArray(c)) lines.push(`<li><b>${esc(c[0])}</b> ${esc(c.slice(1).join(' '))}</li>`);
    else for (const [k, v] of Object.entries(c)) lines.push(`<li><b>${esc(k)}</b> ${esc(/credential/i.test(k) ? mask(v) : v)}</li>`);
  }
  const sig = slip.fields['X-Amz-Signature'];
  if (sig) lines.push(`<li><b>X-Amz-Signature</b> ${esc(sig.slice(0, 8))}… (HMAC-SHA256 with the secret key, which stays on the server)</li>`);
  $('#slipConds').innerHTML = lines.join('');
  $('#slipDetails').hidden = false;
}

async function expose(file) {
  if (busy) return;
  setBusy(true, 'Exposing');
  for (const n of Object.keys(steps)) setStep(n, null, '');
  $('#meterBar').style.width = '0';
  $('#appBytes').textContent = '0 B';
  $('#cellarBytes').textContent = '0 B';
  let at = 'slip';
  try {
    // 1. The slip: the app signs, it does not receive anything but a type and a size.
    setActors('browser', 'app');
    setStep('slip', 'is-active');
    const slip = await api('/api/slips', { method: 'POST', body: JSON.stringify({ type: file.type, size: file.size }) });
    showSlip(slip);
    setStep('slip', 'is-done', `<span class="ok">201</span> · ${esc(slip.key)} · expires in ${slip.expiresIn} s`);

    // 2. The exposure: the browser talks to Cellar directly.
    at = 'expose';
    setActors('browser', 'cellar');
    setStep('expose', 'is-active', `POST ${esc(short(slip.url))} · ${bytes(file.size)}`);
    const t0 = performance.now();
    const sent = await postToCellar(slip, file, { onProgress: (r) => { $('#meterBar').style.width = `${Math.round(r * 100)}%`; } });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (sent.status !== 201) throw Object.assign(new Error(sent.status ? `Cellar answered ${sent.status} ${sent.code ?? ''}` : 'The browser could not reach Cellar (network or CORS)'), { step: 'expose' });
    $('#cellarBytes').textContent = bytes(file.size);
    setStep('expose', 'is-done', `POST ${esc(short(slip.url))} → <span class="ok">201 Created</span> · ${bytes(file.size)} in ${secs} s · ETag ${esc((sent.etag ?? '').slice(0, 12))}…`);

    // 3. Development: the app checks the first bytes, then Cellar copies the object to prints/.
    at = 'develop';
    setActors('app', 'cellar');
    setStep('develop', 'is-active');
    let out;
    try {
      out = await api('/api/develop', { method: 'POST', body: JSON.stringify({ key: slip.key }) });
    } catch (err) {
      $('[data-out]', steps.develop).innerHTML = (err.data?.trace ?? []).map((t) => `<li><b>${esc(t.call)}</b> ${esc(t.result)}</li>`).join('');
      throw err;
    }
    $('#appBytes').textContent = bytes(out.appBytes);
    setStep('develop', 'is-done', out.trace.map((t) => `<li><b>${esc(t.call)}</b> ${esc(t.result)} <span class="ok">· app read ${t.appBytes} B</span></li>`).join(''));

    // 4. On the line: the print is loaded from Cellar's public URL.
    at = 'hang';
    setActors('cellar', 'browser');
    setStep('hang', 'is-active', `GET ${esc(short(out.print.url))} · anonymous`);
    prints = [out.print, ...prints.filter((p) => p.id !== out.print.id)].slice(0, boot.maxPrints);
    const el = printEl(out.print, true);
    const t1 = performance.now();
    const loaded = new Promise((resolve) => { const img = $('img', el); img.onload = () => resolve(true); img.onerror = () => resolve(false); });
    renderLine();
    $('#line').firstChild.replaceWith(el);
    const ok = await loaded;
    setStep('hang', ok ? 'is-done' : 'is-failed', ok
      ? `GET ${esc(short(out.print.url))} → <span class="ok">200</span> from Cellar in ${Math.round(performance.now() - t1)} ms, no signature`
      : `GET ${esc(short(out.print.url))} → <span class="bad">failed</span>`);
    setActors();
    setBusy(false, 'Developed');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    const step = steps[err.step ?? at];
    const out = $('[data-out]', step);
    const line = document.createElement(out.tagName === 'UL' ? 'li' : 'span');
    line.className = 'bad';
    line.textContent = err.message;
    if (out.tagName !== 'UL' && out.textContent) out.append(document.createElement('br'));
    out.append(line);
    setStep(err.step ?? at, 'is-failed');
    setActors();
    setBusy(false, 'Failed');
  }
}

/* ---------- Sources: a photogram drawn here, or the visitor's photo ---------- */
function canvasToJpeg(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}
async function drawPhotogram() {
  const { svg } = photogram(Math.floor(Math.random() * 1e6));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * 1.5;
    canvas.height = HEIGHT * 1.5;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvasToJpeg(canvas, 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}
// Re-encode in the browser: smaller file, and EXIF (GPS position, camera serial) is left behind.
async function preparePhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
  const bitmap = await createImageBitmap(file);
  for (const [side, quality] of [[2000, 0.88], [1600, 0.8], [1200, 0.72]]) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToJpeg(canvas, quality);
    if (blob.size <= boot.maxBytes) return blob;
  }
  throw new Error('This photo stays over 5 MB even re-encoded');
}

$('#drawBtn').addEventListener('click', async () => expose(await drawPhotogram()));
$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    expose(await preparePhoto(file));
  } catch (err) {
    setStep('slip', 'is-failed', `<span class="bad">${esc(err.message)}</span>`);
  }
});

/* ---------- House rules, read back from Cellar ---------- */
function highlight(obj) {
  return esc(JSON.stringify(obj, null, 2))
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/(:\s*|\[\s*|,\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="s">$2</span>');
}
async function loadRules() {
  try {
    const r = await api('/api/rules');
    $('#policyCode').innerHTML = r.policy ? highlight(r.policy) : 'No bucket policy';
    $('#corsCode').innerHTML = r.cors.length ? highlight(r.cors) : 'No CORS rule';
  } catch (err) {
    $('#policyCode').textContent = err.message;
    $('#corsCode').textContent = err.message;
  }
}

/* ---------- Five live checks ---------- */
function showProof(i, status, code, expect, note) {
  const td = $(`[data-proof="${i}"] [data-got]`);
  td.className = status === expect ? 'ok' : 'bad';
  td.innerHTML = `${esc(status || 'blocked')}${code ? ` ${esc(code)}` : ''}${note ? `<small>${esc(note)}</small>` : ''}`;
}
async function runProofs() {
  const btn = $('#proofBtn');
  btn.disabled = true;
  document.querySelectorAll('[data-got]').forEach((td) => { td.className = ''; td.textContent = '…'; });
  try {
    const { probes } = await api('/api/probes');
    probes.forEach((p, i) => showProof(i, p.status, p.code, p.expect, short(p.url)));
    // Two tries straight from this browser to Cellar, each with a real slip from the app.
    const big = await api('/api/slips', { method: 'POST', body: JSON.stringify({ type: 'image/jpeg', size: boot.maxBytes }) });
    const tooBig = await postToCellar(big, new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/jpeg' }));
    showProof(3, tooBig.status, tooBig.code, 400, '6 MB sent, slip allows 5 MB');
    const img = await api('/api/slips', { method: 'POST', body: JSON.stringify({ type: 'image/jpeg', size: 64 }) });
    const html = await postToCellar(img, new Blob(['<h1>not a photo</h1>'], { type: 'text/html' }), { contentType: 'text/html' });
    showProof(4, html.status, html.code, 403, 'slip says image/jpeg');
  } catch (err) {
    document.querySelectorAll('[data-got]').forEach((td) => { if (td.textContent === '…') { td.className = 'bad'; td.textContent = err.message; } });
  } finally {
    btn.disabled = false;
  }
}
$('#proofBtn').addEventListener('click', runProofs);

/* ---------- Start ---------- */
renderPlatform();
$('#publicBase').textContent = boot.publicBase ? `${short(boot.publicBase)}/prints/` : 'no bucket';
if (boot.problem) {
  $('#bootProblem').textContent = boot.problem;
  $('#bootProblem').hidden = false;
}
checkHealth();
loadPrints();
loadRules();
