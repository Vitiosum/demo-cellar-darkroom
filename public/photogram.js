// Photograms: cameraless photographs. Objects laid on photo paper, exposed under the enlarger:
// where an object blocked the light, the paper stays white. Drawn as SVG, the same seed gives the same print.
// Shared by the server (the seed prints) and the browser (the "draw a photogram" button).

export const WIDTH = 800;
export const HEIGHT = 1000;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => Math.round(n * 10) / 10;

function fern(r, s) {
  const len = 520 * s;
  let out = `<path d="M0 0 Q ${f(len * 0.12)} ${f(-len * 0.5)} 0 ${f(-len)}" fill="none" stroke="#fff" stroke-width="${f(5 * s)}" stroke-linecap="round"/>`;
  const n = 15 + Math.floor(r() * 6);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const py = -len * t;
    const px = len * 0.12 * 2 * t * (1 - t);
    const size = (1 - t * 0.85) * 120 * s;
    for (const side of [-1, 1]) {
      const a = side * (58 + r() * 14) - 8;
      out += `<path transform="translate(${f(px)} ${f(py)}) rotate(${f(a)})" d="M0 0 Q ${f(size * 0.22)} ${f(-size * 0.5)} 0 ${f(-size)} Q ${f(-size * 0.22)} ${f(-size * 0.5)} 0 0Z" fill="#fff"/>`;
    }
  }
  return { body: out, name: 'fern', reach: len };
}

function leaf(r, s) {
  const l = 380 * s;
  const w = l * (0.34 + r() * 0.12);
  let out = `<path d="M0 0 C ${f(w)} ${f(-l * 0.25)} ${f(w * 0.8)} ${f(-l * 0.8)} 0 ${f(-l)} C ${f(-w * 0.8)} ${f(-l * 0.8)} ${f(-w)} ${f(-l * 0.25)} 0 0Z" fill="#fff" fill-opacity="0.92"/>`;
  out += `<path d="M0 ${f(l * 0.18)} L0 ${f(-l * 0.95)}" stroke="#0b0b0c" stroke-opacity="0.55" stroke-width="${f(3 * s)}"/>`;
  for (let i = 1; i < 8; i++) {
    const py = -l * (i / 8.5);
    const reach = w * 0.75 * Math.sin(Math.PI * (i / 8.5));
    out += `<path d="M0 ${f(py)} Q ${f(reach * 0.5)} ${f(py - 24 * s)} ${f(reach)} ${f(py - 52 * s)} M0 ${f(py)} Q ${f(-reach * 0.5)} ${f(py - 24 * s)} ${f(-reach)} ${f(py - 52 * s)}" fill="none" stroke="#0b0b0c" stroke-opacity="0.4" stroke-width="${f(1.6 * s)}"/>`;
  }
  return { body: out, name: 'leaf', reach: l };
}

function key(r, s) {
  const k = 340 * s;
  const ring = 52 * s;
  let out = `<circle cx="0" cy="${f(-k)}" r="${f(ring)}" fill="none" stroke="#fff" stroke-width="${f(17 * s)}"/>`;
  out += `<circle cx="0" cy="${f(-k)}" r="${f(ring * 0.42)}" fill="none" stroke="#fff" stroke-width="${f(4 * s)}" stroke-opacity="0.7"/>`;
  out += `<rect x="${f(-9 * s)}" y="${f(-k + ring)}" width="${f(18 * s)}" height="${f(k - ring)}" rx="${f(5 * s)}" fill="#fff"/>`;
  out += `<rect x="${f(-20 * s)}" y="${f(-k + ring + 14 * s)}" width="${f(40 * s)}" height="${f(14 * s)}" rx="${f(4 * s)}" fill="#fff"/>`;
  const teeth = 3 + Math.floor(r() * 3);
  for (let i = 0; i < teeth; i++) {
    const h = (22 + r() * 34) * s;
    out += `<rect x="${f(6 * s)}" y="${f(-i * 26 * s - 26 * s)}" width="${f(h)}" height="${f(17 * s)}" fill="#fff"/>`;
  }
  return { body: out, name: 'key', reach: k + ring };
}

function doily(r, s) {
  const R = 190 * s;
  let out = `<g fill-opacity="0.9"><circle r="${f(R)}" fill="#fff"/>`;
  const petals = 18 + Math.floor(r() * 10);
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    out += `<circle cx="${f(Math.cos(a) * R)}" cy="${f(Math.sin(a) * R)}" r="${f(R * 0.12)}" fill="#fff"/>`;
  }
  out += '</g>';
  for (const [ring, count, hole] of [[0.82, petals, 0.07], [0.6, Math.round(petals * 0.75), 0.06], [0.38, Math.round(petals * 0.5), 0.055], [0.16, 6, 0.045]]) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ring;
      out += `<circle cx="${f(Math.cos(a) * R * ring)}" cy="${f(Math.sin(a) * R * ring)}" r="${f(R * hole)}" fill="#0b0b0c" fill-opacity="0.85"/>`;
    }
  }
  out += `<circle r="${f(R * 0.05)}" fill="#0b0b0c"/>`;
  return { body: out, name: 'lace', reach: R * 1.1 };
}

function marbles(r, s) {
  const n = 3 + Math.floor(r() * 5);
  let out = '';
  for (let i = 0; i < n; i++) {
    const cx = (r() - 0.5) * 300 * s;
    const cy = (r() - 0.5) * 300 * s;
    const rad = (34 + r() * 38) * s;
    out += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rad)}" fill="url(#glass)"/>`;
  }
  return { body: out, name: 'marbles', reach: 180 * s };
}

function feather(r, s) {
  const l = 460 * s;
  let out = `<path d="M0 ${f(l * 0.1)} Q ${f(l * 0.06)} ${f(-l * 0.5)} 0 ${f(-l)}" fill="none" stroke="#fff" stroke-width="${f(4 * s)}" stroke-linecap="round"/>`;
  const barbs = 54;
  for (let i = 4; i < barbs; i++) {
    const t = i / barbs;
    const py = -l * t;
    const px = l * 0.06 * 2 * t * (1 - t);
    const w = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 92 * s * (0.85 + r() * 0.3);
    const o = (0.45 + r() * 0.45).toFixed(2);
    out += `<path d="M${f(px)} ${f(py)} q ${f(w * 0.6)} ${f(-w * 0.18)} ${f(w)} ${f(-w * 0.62)} M${f(px)} ${f(py)} q ${f(-w * 0.6)} ${f(-w * 0.18)} ${f(-w)} ${f(-w * 0.62)}" fill="none" stroke="#fff" stroke-opacity="${o}" stroke-width="${f(1.8 * s)}"/>`;
  }
  return { body: out, name: 'feather', reach: l };
}

function clips(r, s) {
  const n = 2 + Math.floor(r() * 3);
  let out = '';
  for (let i = 0; i < n; i++) {
    const cx = (r() - 0.5) * 220 * s;
    const cy = (r() - 0.5) * 220 * s;
    const a = r() * 180;
    const w = 36 * s;
    const h = 126 * s;
    out += `<path transform="translate(${f(cx)} ${f(cy)}) rotate(${f(a)})" d="M${f(w * 0.3)} ${f(h * 0.25)} V${f(-h * 0.35)} a${f(w * 0.3)} ${f(w * 0.3)} 0 0 0 ${f(-w * 0.6)} 0 V${f(h * 0.4)} a${f(w * 0.5)} ${f(w * 0.5)} 0 0 0 ${f(w)} 0 V${f(-h * 0.5)} a${f(w * 0.7)} ${f(w * 0.7)} 0 0 0 ${f(-w * 1.4)} 0 V${f(h * 0.3)}" fill="none" stroke="#fff" stroke-width="${f(5 * s)}" stroke-linecap="round"/>`;
  }
  return { body: out, name: 'paper clips', reach: 160 * s };
}

const OBJECTS = [fern, leaf, key, doily, marbles, feather, clips];

// One photogram: 2 to 4 objects on black paper, with the soft halo of light bleeding under their edges.
export function photogram(seed) {
  const r = rng(seed);
  const count = 2 + Math.floor(r() * 2);
  const pool = [...OBJECTS];
  const placed = [];
  let layers = '';
  for (let i = 0; i < count; i++) {
    const draw = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const s = 1.05 + r() * 0.55;
    const x = 190 + r() * (WIDTH - 380);
    const y = 280 + r() * (HEIGHT - 480);
    const { body, name, reach } = draw(r, s);
    // Anchor long objects near the bottom so they cross the sheet instead of leaving it.
    const yy = reach > 300 ? Math.min(HEIGHT - 60, y + reach * 0.45) : y;
    const a = (r() - 0.5) * 120;
    layers += `<g transform="translate(${f(x)} ${f(yy)}) rotate(${f(a)})">${body}</g>`;
    placed.push(name);
  }
  const tone = 8 + Math.floor(r() * 6);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">`
    + '<defs>'
    + '<radialGradient id="glass"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.25"/><stop offset="0.86" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0.95"/></radialGradient>'
    + '<radialGradient id="fall" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>'
    + '<filter id="halo" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>'
    + `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="${seed % 997}"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0"/></filter>`
    + '</defs>'
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="rgb(${tone},${tone},${tone + 1})"/>`
    + `<g filter="url(#halo)" opacity="0.5">${layers}</g>`
    + `<g fill="#f4f1ea">${layers.replaceAll('#fff', '#f4f1ea')}</g>`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#fall)"/>`
    + `<rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)"/>`
    + '</svg>';
  const title = placed.length > 1 ? `${placed.slice(0, -1).join(', ')} and ${placed.at(-1)}` : placed[0];
  return { svg, title: title[0].toUpperCase() + title.slice(1) };
}
