import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnappedCut, SnappedCutError } from '../dist/index.js';

/** A fetch that records what it was asked and answers from a script. */
const stub = (replies) => {
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    return new Response(next.body ?? '{}', {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  return { fetch, calls };
};

test('a key is sent as a bearer token, and the base defaults to the site', async () => {
  const { fetch, calls } = stub([{ body: '{"id":"a","email":"e","credits":5,"prices":{}}' }]);
  const sdk = new SnappedCut({ key: 'sk_snapcut_test', fetch });
  await sdk.account();
  assert.equal(calls[0].url, 'https://snappedcut.com/api/account');
});

test('a failing request throws SnappedCutError carrying the status', async () => {
  const { fetch } = stub([{ status: 402, body: '{"error":"Not enough credits."}' }]);
  const sdk = new SnappedCut({ key: 'sk_snapcut_test', fetch });
  await assert.rejects(
    () => sdk.account(),
    (err) => err instanceof SnappedCutError && err.status === 402,
  );
});

test('render never sends a duration — the server prices off the bundle', async () => {
  const { fetch, calls } = stub([
    { body: '{"job":{"id":"j1","kind":"cloud-render","state":"queued","error":null,"seconds":4,"createdAt":0,"updatedAt":0},"charged":8,"credits":92,"priced":{"seconds":4,"project":"p","layers":2}}' },
  ]);
  const sdk = new SnappedCut({ key: 'sk_snapcut_test', fetch });
  const job = await sdk.render(new Uint8Array(32));
  assert.equal(job.charged, 8);
  assert.equal(job.priced.seconds, 4);
  // A caller-supplied duration would be a caller-supplied price.
  assert.ok(!calls[0].url.includes('seconds='));
});

test('wait polls until done, reports each state, then returns the bytes', async () => {
  const running = '{"id":"j1","kind":"cloud-render","state":"running","error":null,"seconds":4,"createdAt":0,"updatedAt":0}';
  const done = '{"id":"j1","kind":"cloud-render","state":"done","error":null,"seconds":4,"createdAt":0,"updatedAt":0}';
  const { fetch } = stub([
    { body: running },
    { body: done },
    { body: 'MOVIE', headers: { 'content-type': 'video/webm' } },
  ]);
  const seen = [];
  const sdk = new SnappedCut({ key: 'sk_snapcut_test', fetch });
  const bytes = await sdk.wait('j1', { onState: (j) => seen.push(j.state) });
  assert.deepEqual(seen, ['running', 'done']);
  assert.equal(new TextDecoder().decode(bytes), 'MOVIE');
});

test('a failed job throws rather than returning an empty file', async () => {
  const failed = '{"id":"j1","kind":"cloud-render","state":"failed","error":"decode failed","seconds":4,"createdAt":0,"updatedAt":0}';
  const { fetch } = stub([{ body: failed }]);
  const sdk = new SnappedCut({ key: 'sk_snapcut_test', fetch });
  await assert.rejects(() => sdk.wait('j1'), /decode failed/);
});

test('verifyWebhook accepts our signature inside five minutes, and nothing else', async () => {
  const secret = 'whsec_snapcut_test';
  const body = '{"id":"evt_1","type":"job.succeeded"}';
  const header = 't=1760000000000,v1=54c2adf2a351242de19b156794d65c56bebf9fc56cadac990c56b979a7a61ab2';
  assert.equal(await SnappedCut.verifyWebhook(secret, body, header, 1760000001000), true);
  assert.equal(await SnappedCut.verifyWebhook(secret, body, header, 1760000400000), false);
  assert.equal(await SnappedCut.verifyWebhook(secret, `${body} `, header, 1760000001000), false);
  assert.equal(await SnappedCut.verifyWebhook('whsec_other', body, header, 1760000001000), false);
  assert.equal(await SnappedCut.verifyWebhook(secret, body, 't=1760000000000,v1=zz', 1760000001000), false);
});

test('create sends the Idempotency-Key as a header and the job as JSON', async () => {
  const { fetch, calls } = stub([{ status: 202, body: '{"job":{"id":"job_1"},"charged":2,"price":2,"credits":8}' }]);
  const sdk = new SnappedCut({ key: 'sk_snapcut_x', base: 'https://example.test', fetch });
  const made = await sdk.create({ design: { clips: [{ type: 'text', text: 'hi' }] }, outputs: [{ preset: 'vertical' }] }, { idempotencyKey: 'k-1' });
  assert.equal(made.job.id, 'job_1');
  assert.equal(calls[0].url, 'https://example.test/api/jobs');
  assert.equal(calls[0].headers.get('idempotency-key'), 'k-1');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk_snapcut_x');
  assert.deepEqual(JSON.parse(String(calls[0].body)).outputs, [{ preset: 'vertical' }]);
});

test('upload sends chunks at the right offsets without the key, then confirms', async () => {
  const asset = '{"asset":{"id":"as_1","name":"clip.webm","contentType":"video/webm","bytes":5,"confirmed":true}}';
  const { fetch, calls } = stub([
    { body: '{"assetId":"as_1","upload":{"url":"https://up.test/put?token=t","maxChunkBytes":3}}' },
    { body: '{}' },
    { body: '{}' },
    { body: asset },
  ]);
  const sdk = new SnappedCut({ key: 'sk_snapcut_x', base: 'https://example.test', fetch });
  const made = await sdk.upload(new Uint8Array(5), { name: 'clip.webm', contentType: 'video/webm' });
  assert.equal(made.id, 'as_1');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'POST https://example.test/api/uploads',
    'PUT https://up.test/put?token=t&offset=0',
    'PUT https://up.test/put?token=t&offset=3',
    'POST https://example.test/api/uploads/as_1/confirm',
  ]);
  // The upload URL carries its own permission; the API key must not travel to it.
  assert.equal(calls[1].headers.get('authorization'), null);
  assert.equal(calls[2].headers.get('authorization'), null);
});
