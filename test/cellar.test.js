// The real S3 calls, against a local S3 (moto): S3_TEST_ENDPOINT=http://localhost:9100 npm test
// Skipped without it. Moto does not enforce bucket policies, so the 403 checks are proven on Cellar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellarConfig } from '../src/rules.js';
import { createCellar } from '../src/cellar.js';
import { photogram } from '../public/photogram.js';

const endpoint = process.env.S3_TEST_ENDPOINT;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

test('slip, browser-style POST, develop, list, sweep', { skip: !endpoint && 'set S3_TEST_ENDPOINT' }, async () => {
  const cfg = cellarConfig({ CELLAR_ADDON_HOST: endpoint, CELLAR_ADDON_KEY_ID: 'test', CELLAR_ADDON_KEY_SECRET: 'test', CELLAR_BUCKET: `darkroom-test-${Date.now()}` });
  const cellar = createCellar(cfg, { origins: ['http://localhost:8080'] });
  await cellar.prepare();
  await cellar.prepare(); // idempotent
  const rules = await cellar.rules();
  assert.equal(rules.policy.Statement[0].Resource[0], `arn:aws:s3:::${cfg.bucket}/prints/*`);
  assert.deepEqual(rules.cors[0].AllowedMethods, ['POST']);

  assert.equal(await cellar.seed([photogram(1), photogram(2)]), 2);
  assert.equal(await cellar.seed([photogram(1)]), 0);

  const slip = await cellar.slip('image/jpeg');
  const form = new FormData();
  for (const [k, v] of Object.entries(slip.fields)) form.append(k, v);
  form.append('file', new Blob([JPEG], { type: 'image/jpeg' }));
  const sent = await fetch(slip.url, { method: 'POST', body: form });
  assert.equal(sent.status, 201);

  const out = await cellar.develop(slip.key);
  assert.equal(out.status, 201);
  assert.equal(out.appBytes, 16);
  assert.deepEqual(out.trace.map((t) => t.call.split(' ')[0]), ['HeadObject', 'GetObject', 'CopyObject']);
  const prints = await cellar.listPrints();
  assert.equal(prints.length, 3);
  assert.equal(prints.find((p) => p.id === out.print.id).size, JPEG.length);
  assert.ok((await cellar.negativeLink(out.print.id)).url.includes('X-Amz-Signature'));

  // A file that is not what its slip says is thrown away.
  const liar = await cellar.slip('image/png');
  const form2 = new FormData();
  for (const [k, v] of Object.entries(liar.fields)) form2.append(k, v);
  form2.append('file', new Blob(['<html>'], { type: 'image/png' }));
  assert.equal((await fetch(liar.url, { method: 'POST', body: form2 })).status, 201);
  assert.equal((await cellar.develop(liar.key)).status, 422);
  assert.equal((await cellar.develop(liar.key)).status, 404);
  assert.equal((await cellar.develop('prints/whatever.jpg')).status, 400);

  // A negative nobody developed is swept once it is old enough.
  const orphan = await cellar.slip('image/jpeg');
  const form3 = new FormData();
  for (const [k, v] of Object.entries(orphan.fields)) form3.append(k, v);
  form3.append('file', new Blob([JPEG], { type: 'image/jpeg' }));
  await fetch(orphan.url, { method: 'POST', body: form3 });
  assert.equal(await cellar.sweep(), 0);
  assert.equal(await cellar.sweep(Date.now() + 11 * 60_000), 1);

  // Teardown empties the bucket and deletes it, and does nothing the second time.
  assert.equal(await cellar.teardown(), 6);
  assert.equal(await cellar.teardown(), 0);
});

// The anonymous checks, with Cellar's answers played back: no network, no local S3 needed.
test('probes: 200 on a print, 403 AccessDenied on its negative, 200 presigned', async () => {
  const { s3Client } = await import('../src/cellar.js');
  const cfg = cellarConfig({ CELLAR_ADDON_HOST: 'cellar.example', CELLAR_ADDON_KEY_ID: 'test', CELLAR_ADDON_KEY_SECRET: 'test' });
  const client = s3Client(cfg);
  const id = '0aaaaaaa-0000-4000-8000-000000000000';
  client.send = async (cmd) => ({ Contents: [{ Key: `${cmd.input.Prefix.startsWith('prints/') ? 'prints/' : 'darkroom/'}${id}.jpg`, Size: 10, LastModified: new Date() }] });
  const fetchImpl = async (url) => (url.includes('/darkroom/') && !url.includes('X-Amz-Signature')
    ? new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', { status: 403 })
    : new Response('x', { status: 206 }));
  const probes = await createCellar(cfg, { origins: [], client, fetchImpl }).probes();
  assert.deepEqual(probes.map((p) => [p.status, p.code, p.ok]), [[200, null, true], [403, 'AccessDenied', true], [200, null, true]]);
  assert.ok(probes[2].url.endsWith('?X-Amz-…'));
});

// A file swapped during development never reaches prints/.
function stubDevelop(copyAnswer) {
  return async () => {
    const { s3Client } = await import('../src/cellar.js');
    const cfg = cellarConfig({ CELLAR_ADDON_HOST: 'cellar.example', CELLAR_ADDON_KEY_ID: 'test', CELLAR_ADDON_KEY_SECRET: 'test' });
    const client = s3Client(cfg);
    const calls = [];
    client.send = async (cmd) => {
      calls.push([cmd.constructor.name, cmd.input]);
      switch (cmd.constructor.name) {
        case 'HeadObjectCommand': return { ContentLength: JPEG.length, ContentType: 'image/jpeg', ETag: '"checked"' };
        case 'GetObjectCommand': return { ETag: '"checked"', Body: { transformToByteArray: async () => JPEG.subarray(0, 16) } };
        case 'CopyObjectCommand': return copyAnswer();
        default: return { Contents: [] };
      }
    };
    const key = 'darkroom/0aaaaaaa-0000-4000-8000-000000000000.jpg';
    const out = await createCellar(cfg, { origins: [], client }).develop(key);
    const deleted = calls.filter(([n]) => n === 'DeleteObjectsCommand').flatMap(([, i]) => i.Delete.Objects.map((o) => o.Key));
    return { out, calls, deleted, key };
  };
}

test('develop: every call after the check is conditional on its ETag', async () => {
  const { out, calls } = await stubDevelop(() => ({ CopyObjectResult: { ETag: '"checked"' } }))();
  assert.equal(out.status, 201);
  assert.equal(calls.find(([n]) => n === 'GetObjectCommand')[1].IfMatch, '"checked"');
  assert.equal(calls.find(([n]) => n === 'CopyObjectCommand')[1].CopySourceIfMatch, '"checked"');
});

test('develop: Cellar refuses the copy of a swapped file (412), nothing is published', async () => {
  const { out, deleted, key } = await stubDevelop(() => { throw Object.assign(new Error('PreconditionFailed'), { $metadata: { httpStatusCode: 412 } }); })();
  assert.equal(out.status, 409);
  assert.deepEqual(deleted, [key]);
});

test('develop: a server that ignored the condition still gets the print thrown away', async () => {
  const { out, deleted, key } = await stubDevelop(() => ({ CopyObjectResult: { ETag: '"swapped"' } }))();
  assert.equal(out.status, 409);
  assert.deepEqual(deleted.sort(), [key, key.replace('darkroom/', 'prints/')].sort());
});
