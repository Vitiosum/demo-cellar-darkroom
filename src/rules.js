// The darkroom's rules, as plain data: no network here, so all of it is unit-tested.
import { createHash, randomUUID } from 'node:crypto';

export const MAX_BYTES = 5 * 1024 * 1024; // enforced by Cellar itself, through the presigned POST policy
export const SLIP_SECONDS = 60; // how long a presigned POST stays valid
export const NEGATIVE_SECONDS = 60; // how long a presigned GET on a negative stays valid
export const MAX_PRINTS = 40; // the line holds 40 prints, the oldest come down first
export const SNIFF_BYTES = 16; // the only part of a visitor's file the app ever reads

export const NEGATIVES = 'darkroom/'; // private: no policy statement covers it
export const PRINTS = 'prints/'; // public: the bucket policy allows anonymous s3:GetObject here

// What a browser may send. Seeds (drawn by the app) are SVG, visitors send rasters only.
export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const EXT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' };

const KEY = /^(darkroom|prints)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp|svg)$/;

// Cellar add-on variables, read as the add-on injects them.
export function cellarConfig(env = process.env) {
  const missing = ['CELLAR_ADDON_HOST', 'CELLAR_ADDON_KEY_ID', 'CELLAR_ADDON_KEY_SECRET'].filter((n) => !env[n]);
  if (missing.length) return { ok: false, missing };
  const host = env.CELLAR_ADDON_HOST.trim();
  const url = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const pathStyle = local || env.CELLAR_PATH_STYLE === 'true';
  // Bucket names are global on Cellar: derive one from the key id, so each add-on gets its own.
  const bucket = env.CELLAR_BUCKET || `darkroom-${createHash('sha256').update(env.CELLAR_ADDON_KEY_ID).digest('hex').slice(0, 12)}`;
  const publicBase = pathStyle ? `${url.origin}/${bucket}` : `${url.protocol}//${bucket}.${url.host}`;
  return {
    ok: true,
    endpoint: url.origin,
    host: url.host,
    bucket,
    pathStyle,
    publicBase,
    publicOrigin: new URL(publicBase).origin,
    keyId: env.CELLAR_ADDON_KEY_ID,
    secret: env.CELLAR_ADDON_KEY_SECRET,
  };
}

// The origins allowed to POST into the bucket: the app's own default domain, plus CORS_ORIGINS.
export function appOrigins(env = process.env) {
  const extra = (env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const own = [];
  if (env.APP_ID?.startsWith('app_')) own.push(`https://app-${env.APP_ID.slice(4)}.cleverapps.io`);
  else {
    const port = Number(env.PORT) || 8080;
    own.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  return [...new Set([...own, ...extra])];
}

// PutBucketCors: only these origins may send files from a browser. Reading prints needs no CORS (<img>).
export function corsRules(origins) {
  return [{
    ID: 'browser-uploads',
    AllowedOrigins: origins,
    AllowedMethods: ['POST'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'Location'],
    MaxAgeSeconds: 600,
  }];
}

// PutBucketPolicy: anyone may read prints/*, nothing else. The darkroom stays private.
export function bucketPolicy(bucket) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'PublicPrints',
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${bucket}/${PRINTS}*`],
    }],
  };
}

export function newNegativeKey(type) {
  return `${NEGATIVES}${randomUUID()}.${UPLOAD_TYPES[type]}`;
}

// A stable id for seed n, so two instances booting together write the same keys.
export function seedId(n) {
  const h = createHash('sha256').update(`darkroom-seed-${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function parseKey(key) {
  const m = KEY.exec(String(key));
  if (!m) return null;
  return { kind: m[1] === 'prints' ? 'print' : 'negative', id: m[2], ext: m[3], type: EXT_TYPES[m[3]] };
}

export const printKey = (id, ext) => `${PRINTS}${id}.${ext}`;
export const negativeKey = (id, ext) => `${NEGATIVES}${id}.${ext}`;

// The request for a slip: a declared type and size. Cellar checks both again when the file arrives.
export function checkSlipRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'Send JSON: {"type": "image/jpeg", "size": 123456}' };
  const { type, size } = body;
  if (!Object.hasOwn(UPLOAD_TYPES, type)) return { error: `Type must be one of ${Object.keys(UPLOAD_TYPES).join(', ')}` };
  if (!Number.isInteger(size) || size < 1) return { error: 'Size must be a positive integer, in bytes' };
  if (size > MAX_BYTES) return { error: `Too big: ${size} bytes, the limit is ${MAX_BYTES}`, status: 413 };
  return { type, size };
}

// Magic numbers: the first bytes of the file say what it really is, whatever its name.
export function sniff(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const hex = (bytes) => [...Buffer.from(bytes)].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
