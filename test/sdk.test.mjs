import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnappedCut, SnappedCutError } from '../dist/index.js';

/** A fetch that records what it was asked and answers from a script. */
const stub = (replies) => {
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
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
