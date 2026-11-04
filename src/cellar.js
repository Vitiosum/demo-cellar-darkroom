// Every call the app makes to Cellar, with the standard AWS SDK for JavaScript v3.
// Nothing here is specific to Clever Cloud but the endpoint and the CELLAR_ADDON_* variable names.
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand, GetBucketCorsCommand,
  PutBucketPolicyCommand, GetBucketPolicyCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand,
  CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  MAX_BYTES, SLIP_SECONDS, NEGATIVE_SECONDS, MAX_PRINTS, SNIFF_BYTES, NEGATIVES, PRINTS,
  corsRules, bucketPolicy, newNegativeKey, parseKey, printKey, negativeKey, sniff, hex, seedId,
} from './rules.js';

export function s3Client(cfg) {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: 'us-east-1', // required by the SDK, not used by Cellar
    forcePathStyle: cfg.pathStyle,
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
    // SDK v3.729+ adds CRC32 checksums to every upload by default: only send them when S3 requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

const errorCode = (err) => err?.Code || err?.name || 'Error';

export function createCellar(cfg, { origins, client = s3Client(cfg), fetchImpl = fetch } = {}) {
  const Bucket = cfg.bucket;
  const publicUrl = (key) => `${cfg.publicBase}/${key}`;

  // At boot: the bucket, its CORS rules and its policy. Idempotent, safe on every instance.
  async function prepare() {
    const steps = [];
    try {
      await client.send(new CreateBucketCommand({ Bucket }));
      steps.push(`CreateBucket ${Bucket}: created`);
    } catch (err) {
      if (errorCode(err) !== 'BucketAlreadyOwnedByYou') {
        if (errorCode(err) === 'BucketAlreadyExists') err.message = `Bucket name ${Bucket} is taken on Cellar: set CELLAR_BUCKET to another name`;
        throw err;
      }
      steps.push(`CreateBucket ${Bucket}: already there`);
    }
    await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: corsRules(origins) } }));
    steps.push(`PutBucketCors: POST allowed from ${origins.join(', ')}`);
    await client.send(new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(bucketPolicy(Bucket)) }));
    steps.push(`PutBucketPolicy: anonymous s3:GetObject on ${PRINTS}* only`);
    return steps;
  }

  // The rules as Cellar holds them now, read back rather than trusted from memory.
  async function rules() {
    const [cors, policy] = await Promise.all([
      client.send(new GetBucketCorsCommand({ Bucket })).then((r) => r.CORSRules ?? [], (e) => { if (errorCode(e) === 'NoSuchCORSConfiguration') return []; throw e; }),
      client.send(new GetBucketPolicyCommand({ Bucket })).then((r) => JSON.parse(r.Policy), (e) => { if (errorCode(e) === 'NoSuchBucketPolicy') return null; throw e; }),
    ]);
    return { bucket: Bucket, endpoint: cfg.endpoint, publicBase: cfg.publicBase, cors, policy };
  }

  // A presigned POST: the browser sends the file to Cellar with these fields, and Cellar checks
  // the key, the content type and the size against the signed policy. The app never sees the bytes.
  async function slip(type) {
    const Key = newNegativeKey(type);
    const post = await createPresignedPost(client, {
      Bucket,
      Key,
      Conditions: [['content-length-range', 1, MAX_BYTES], ['eq', '$Content-Type', type]],
      Fields: { 'Content-Type': type, success_action_status: '201' },
      Expires: SLIP_SECONDS,
    });
    return { key: Key, url: post.url, fields: post.fields, expiresIn: SLIP_SECONDS, maxBytes: MAX_BYTES };
  }

  async function listPrefix(Prefix) {
    const out = [];
    let ContinuationToken;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
      for (const o of page.Contents ?? []) out.push({ key: o.Key, size: o.Size, etag: o.ETag?.replaceAll('"', ''), modified: o.LastModified?.toISOString() });
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return out;
  }

  async function listPrints() {
    const prints = (await listPrefix(PRINTS)).filter((o) => parseKey(o.key)?.kind === 'print');
    prints.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return prints.map((o) => {
      const k = parseKey(o.key);
      return { ...o, id: k.id, type: k.type, url: publicUrl(o.key), negative: negativeKey(k.id, k.ext), negativeUrl: publicUrl(negativeKey(k.id, k.ext)) };
    });
  }

  async function remove(keys) {
    if (!keys.length) return;
    await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
  }

  // Develop a negative: check it really is an image (16 bytes read), then copy it to prints/
  // inside Cellar. The copy is server-side: the file does not travel through the app.
  async function develop(key) {
    const k = parseKey(key);
    if (!k || k.kind !== 'negative' || k.ext === 'svg') return { status: 400, error: 'Not a darkroom key' };
    const trace = [];
    let head;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
    } catch (err) {
      if (['NotFound', 'NoSuchKey'].includes(errorCode(err))) return { status: 404, error: 'Nothing in the darkroom under that key' };
      throw err;
    }
    trace.push({ call: 'HeadObject', target: key, appBytes: 0, result: `${head.ContentLength} bytes, ${head.ContentType}` });
    const first = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${SNIFF_BYTES - 1}` }));
    const bytes = Buffer.from(await first.Body.transformToByteArray());
    const found = sniff(bytes);
    trace.push({ call: `GetObject Range: bytes=0-${SNIFF_BYTES - 1}`, target: key, appBytes: bytes.length, result: `${hex(bytes)} → ${found ?? 'not an image'}` });
    if (found !== k.type || head.ContentType !== k.type) {
      await remove([key]);
      trace.push({ call: 'DeleteObject', target: key, appBytes: 0, result: 'thrown away' });
      return { status: 422, error: `The file is not a ${k.type}`, trace };
    }
    const target = printKey(k.id, k.ext);
    const copy = await client.send(new CopyObjectCommand({
      Bucket, Key: target, CopySource: `${Bucket}/${key}`,
      MetadataDirective: 'REPLACE', ContentType: k.type, CacheControl: 'public, max-age=31536000, immutable',
    }));
    const etag = copy.CopyObjectResult?.ETag?.replaceAll('"', '');
    trace.push({ call: 'CopyObject', target: `${key} → ${target}`, appBytes: 0, result: `ETag ${etag}` });
    await trim();
    return {
      status: 201,
      print: { id: k.id, key: target, url: publicUrl(target), size: head.ContentLength, type: k.type, etag, negative: key, negativeUrl: publicUrl(key), modified: new Date().toISOString() },
      trace,
      appBytes: bytes.length,
    };
  }

  // The line holds MAX_PRINTS prints: the oldest come down, with their negatives.
  async function trim() {
    const prints = await listPrints();
    const old = prints.slice(MAX_PRINTS);
    await remove(old.flatMap((p) => [p.key, p.negative]));
  }

  // Negatives nobody developed (a tab closed mid-way) are swept after 10 minutes.
  async function sweep(now = Date.now()) {
    const developed = new Set((await listPrefix(PRINTS)).map((o) => parseKey(o.key)?.id));
    const stale = (await listPrefix(NEGATIVES)).filter((o) => !developed.has(parseKey(o.key)?.id) && now - Date.parse(o.modified) > 10 * 60_000);
    await remove(stale.map((o) => o.key));
    return stale.length;
  }

  async function negativeLink(id) {
    const negatives = await listPrefix(`${NEGATIVES}${id}.`);
    if (!negatives.length) return null;
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: negatives[0].key }), { expiresIn: NEGATIVE_SECONDS });
    return { key: negatives[0].key, url, expiresIn: NEGATIVE_SECONDS };
  }

  // Three requests from the app, the way any stranger on the internet would make them.
  async function probes() {
    const [print] = await listPrints();
    if (!print) return [];
    const link = await negativeLink(print.id);
    const tries = [
      { name: 'Anonymous GET on a print', url: print.url, expect: 200, why: `bucket policy: s3:GetObject on ${PRINTS}*` },
      { name: 'Anonymous GET on its negative', url: print.negativeUrl, expect: 403, why: `no statement covers ${NEGATIVES}*` },
      { name: 'Presigned GET on the negative', url: link?.url, expect: 200, why: `signed by the app, valid ${NEGATIVE_SECONDS} s` },
    ];
    return Promise.all(tries.map(async (t) => {
      const res = await fetchImpl(t.url, { headers: { Range: 'bytes=0-0' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      let body = '';
      if (res.status >= 400) body = await res.text();
      else await res.body?.cancel();
      const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? null;
      const status = res.status === 206 ? 200 : res.status;
      return { name: t.name, url: t.url.split('?')[0] + (t.url.includes('?') ? '?X-Amz-…' : ''), status, code, expect: t.expect, ok: status === t.expect, why: t.why };
    }));
  }

  // Seed prints, drawn by the app at first start, go through the darkroom like any other.
  async function seed(drawings) {
    const prints = await listPrefix(PRINTS);
    if (prints.length) return 0;
    for (const [i, { svg }] of drawings.entries()) {
      const id = seedId(i);
      const neg = negativeKey(id, 'svg');
      await client.send(new PutObjectCommand({ Bucket, Key: neg, Body: svg, ContentType: 'image/svg+xml' }));
      await client.send(new CopyObjectCommand({
        Bucket, Key: printKey(id, 'svg'), CopySource: `${Bucket}/${neg}`,
        MetadataDirective: 'REPLACE', ContentType: 'image/svg+xml', CacheControl: 'public, max-age=31536000, immutable',
      }));
    }
    return drawings.length;
  }

  async function ping() {
    await client.send(new HeadBucketCommand({ Bucket }));
    return true;
  }

  return { bucket: Bucket, publicBase: cfg.publicBase, publicOrigin: cfg.publicOrigin, prepare, rules, slip, develop, listPrints, sweep, negativeLink, probes, seed, ping };
}
