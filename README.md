# @snappedcut/sdk

TypeScript client for the [Snapped Cut](https://snappedcut.com) cloud render API.
**`fetch` and nothing else** — zero runtime dependencies, so it runs unchanged in
Node, a browser, Deno, a Worker or a CI job.

```sh
npm install @snappedcut/sdk
```

```ts
import { SnappedCut } from '@snappedcut/sdk';

const snapcut = new SnappedCut({ key: process.env.SNAPCUT_KEY });

const job = await snapcut.render(bundleBytes);
console.log(`charged ${job.charged} credits for ${job.priced.seconds}s`);

const file = await snapcut.wait(job.id, { onState: (j) => console.log(j.state) });
await writeFile('out.webm', file);
```

Get a key from [your account page](https://snappedcut.com/account) — it looks like
`sk_snapcut_…`. Keep it on a server; it spends credits.

## What this is, and what it is not

Snapped Cut edits video **on the device**. Decode, cut, filter and encode all run
in the browser on WebCodecs, so there is no API for them and there cannot be —
an SDK cannot make Node run WebCodecs.

What this covers is the one thing that *does* happen on our machines: a **cloud
render**, where you hand over a project bundle and get a finished file back.
A client for it should be readable in one sitting.

For driving the real editor, see [`@snappedcut/mcp`](https://github.com/snappedcut-dev/mcp).
For putting the editor in your own page, [`@snappedcut/embed`](https://github.com/snappedcut-dev/embed).

## API

| | |
| --- | --- |
| `new SnappedCut({ key, base?, fetch? })` | `base` defaults to `https://snappedcut.com`. Pass your own `fetch` to mock or instrument. |
| `account()` | Who the key belongs to, credits left, and the current price list. |
| `render(bundle, { kind?, idempotencyKey?, priority? })` | Queues a render. `kind` is `'cloud-render'` or `'cloud-render-4k'`; `priority` is `'interactive'` or `'background'`. |
| `job(id)` / `jobs()` | One job, or every job on the account. |
| `output(id, index?)` | The rendered bytes. Throws unless the job is `done`. |
| `wait(id, { timeoutMs?, onState?, index? })` | Polls to completion, then resolves with the bytes (of output `index`). |
| `create(request, { idempotencyKey? })` | A job as JSON: a `design`, an uploaded `bundle`, or a `tool` over uploaded `inputs`. |
| `batch(jobs, defaults?)` | Up to 100 jobs; each is answered on its own. |
| `compileDesign(design, vars?)` / `renderDesign(design, request?)` | Compile a design to a project, or render it. |
| `operations()` | Every operation, its parameters, and the presets. |
| `upload(data, { name?, contentType })` / `asset(id)` / `deleteAsset(id)` | Upload media once, use it by id. |
| `usage(query?)` / `deleteEndUser(endUserId)` | Usage grouped by `day`, `week`, `month`, `endUser`, `key` or `operation`; erase one end user. |
| `embedToken({ pk, endUserId, ... })` | Mint an embed session token. Server side only. |
| `destinations.list/create/update/delete/test/presign` | Saved S3-compatible buckets to deliver outputs into. |
| `webhooks.list/create/update/delete/rotate/deliveries/test` | Webhook endpoints. The secret comes back once, from `create` and `rotate`. |
| `SnappedCut.verifyWebhook(secret, rawBody, header)` | Checks an `X-Snappedcut-Signature` header. |

### Designs, uploads and several outputs

```ts
const clip = await snapcut.upload(await readFile('clip.webm'), { name: 'clip.webm', contentType: 'video/webm' });

const { job } = await snapcut.renderDesign(
  { clips: [{ type: 'video', asset: clip.id }, { type: 'text', text: 'Launch day', start: 0, duration: 3 }] },
  { outputs: [{ preset: 'vertical' }, { preset: 'square', format: 'webm' }] },
  // A retry with the same key returns the first job instead of charging twice.
  { idempotencyKey: 'launch-2026-11-24' },
);

const vertical = await snapcut.wait(job.id, { index: 0 });
const square = await snapcut.output(job.id, 1);
```

Presets: `source`, `vertical`, `square`, `portrait`, `landscape`, `hd720`, `uhd2160`.

### Webhooks

```ts
const ok = await SnappedCut.verifyWebhook(process.env.SNAPCUT_WEBHOOK_SECRET, rawBody, request.headers.get('x-snappedcut-signature'));
if (!ok) return new Response('bad signature', { status: 400 });
```

Pass the **raw** body, before any JSON parsing. A signature older than five
minutes is refused, so a captured delivery cannot be replayed.

### Large bundles resume themselves

`render()` sends a bundle under 8 MB in one request. Above that it uploads in
chunks, and if the connection drops it carries on from **the server's** count of
what it holds, not its own — a `409` carries the expected offset and the client
believes it. Three attempts per chunk; a `4xx` that is not `409` is a real
refusal (no credits, bad bundle, bad key) and stops immediately rather than
retrying its way through your balance.

### You cannot set the price

There is no `seconds` parameter, deliberately. The server reads the timeline
duration out of the bundle's own `project.json` and prices on that, because a
duration supplied by the caller is a price supplied by the caller. What you were
actually charged comes back as `charged`, with the server's reasoning in `priced`.

### Errors

Every failure throws `SnappedCutError` with the HTTP `status` on it.

```ts
import { SnappedCutError } from '@snappedcut/sdk';

try {
  await snapcut.render(bundle);
} catch (err) {
  if (err instanceof SnappedCutError && err.status === 402) {
    // out of credits — top up and try again
  }
}
```

A job that fails server-side has **already been refunded** by the time `wait()`
throws, so there is nothing to reconcile.

## Releases

Published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
Every tarball links back to the commit and the workflow run that built it.

MIT
