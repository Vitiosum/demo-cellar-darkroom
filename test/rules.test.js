import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellarConfig, appOrigins, corsRules, bucketPolicy, checkSlipRequest, sniff, parseKey, newNegativeKey, seedId, MAX_BYTES } from '../src/rules.js';
import { photogram } from '../public/photogram.js';

const env = { CELLAR_ADDON_HOST: 'cellar-c2.services.clever-cloud.com', CELLAR_ADDON_KEY_ID: 'KEYID', CELLAR_ADDON_KEY_SECRET: 'secret' };

test('cellarConfig: virtual-host public URLs on Cellar, a bucket name per add-on', () => {
  const c = cellarConfig(env);
  assert.equal(c.ok, true);
  assert.equal(c.endpoint, 'https://cellar-c2.services.clever-cloud.com');
  assert.match(c.bucket, /^darkroom-[0-9a-f]{12}$/);
  assert.equal(c.pathStyle, false);
  assert.equal(c.publicBase, `https://${c.bucket}.cellar-c2.services.clever-cloud.com`);
  assert.notEqual(cellarConfig({ ...env, CELLAR_ADDON_KEY_ID: 'OTHER' }).bucket, c.bucket);
  assert.equal(cellarConfig({ ...env, CELLAR_BUCKET: 'mine' }).bucket, 'mine');
});

test('cellarConfig: path style for a local S3, and the missing variables named', () => {
  const c = cellarConfig({ ...env, CELLAR_ADDON_HOST: 'http://localhost:9100' });
  assert.equal(c.pathStyle, true);
  assert.equal(c.publicBase, `http://localhost:9100/${c.bucket}`);
  assert.deepEqual(cellarConfig({}).missing, ['CELLAR_ADDON_HOST', 'CELLAR_ADDON_KEY_ID', 'CELLAR_ADDON_KEY_SECRET']);
});

test('appOrigins: the default cleverapps.io domain comes from APP_ID', () => {
  assert.deepEqual(appOrigins({ APP_ID: 'app_1234-abcd' }), ['https://app-1234-abcd.cleverapps.io']);
  assert.deepEqual(appOrigins({ APP_ID: 'app_x', CORS_ORIGINS: 'https://a.example, https://b.example/' }), ['https://app-x.cleverapps.io', 'https://a.example', 'https://b.example']);
  assert.deepEqual(appOrigins({ PORT: '8095' }), ['http://localhost:8095', 'http://127.0.0.1:8095']);
});

test('corsRules and bucketPolicy: POST from the app only, GetObject on prints/* only', () => {
  const [rule] = corsRules(['https://app-x.cleverapps.io']);
  assert.deepEqual(rule.AllowedMethods, ['POST']);
  assert.deepEqual(rule.AllowedOrigins, ['https://app-x.cleverapps.io']);
  const policy = bucketPolicy('darkroom-abc');
  assert.equal(policy.Statement.length, 1);
  assert.deepEqual(policy.Statement[0].Action, ['s3:GetObject']);
  assert.deepEqual(policy.Statement[0].Resource, ['arn:aws:s3:::darkroom-abc/prints/*']);
});

test('checkSlipRequest: type allowlist and size bounds', () => {
  assert.deepEqual(checkSlipRequest({ type: 'image/jpeg', size: 10 }), { type: 'image/jpeg', size: 10 });
  assert.match(checkSlipRequest({ type: 'text/html', size: 10 }).error, /Type/);
  assert.match(checkSlipRequest({ type: 'image/png', size: 0 }).error, /Size/);
  assert.equal(checkSlipRequest({ type: 'image/png', size: MAX_BYTES + 1 }).status, 413);
  assert.ok(checkSlipRequest(null).error);
  assert.ok(checkSlipRequest({ type: 'constructor', size: 1 }).error);
});

test('sniff: magic numbers, not file names', () => {
  assert.equal(sniff([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
  assert.equal(sniff([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'image/png');
  assert.equal(sniff(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniff(Buffer.from('<html><body>')), null);
});

test('keys: negatives in darkroom/, nothing else parses', () => {
  const key = newNegativeKey('image/webp');
  assert.match(key, /^darkroom\/[0-9a-f-]{36}\.webp$/);
  assert.equal(parseKey(key).kind, 'negative');
  assert.equal(parseKey(key.replace('darkroom/', 'prints/')).kind, 'print');
  assert.equal(parseKey('darkroom/../etc/passwd'), null);
  assert.equal(parseKey(`other/${key.slice(9)}`), null);
  assert.match(seedId(3), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(seedId(3), seedId(3));
});

test('photogram: deterministic SVG, no script', () => {
  const a = photogram(73);
  assert.equal(a.svg, photogram(73).svg);
  assert.notEqual(a.svg, photogram(74).svg);
  assert.match(a.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.doesNotMatch(a.svg, /<script|on\w+=/i);
  assert.ok(a.title.length > 2);
});
