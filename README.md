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
That is five endpoints, and a client for it should be readable in one sitting.

For driving the real editor, see [`@snappedcut/mcp`](https://github.com/snappedcut-dev/mcp).
For putting the editor in your own page, [`@snappedcut/embed`](https://github.com/snappedcut-dev/embed).

## API

| | |
| --- | --- |
| `new SnappedCut({ key, base?, fetch? })` | `base` defaults to `https://snappedcut.com`. Pass your own `fetch` to mock or instrument. |
| `account()` | Who the key belongs to, credits left, and the current price list. |
| `render(bundle, { kind? })` | Queues a render. `kind` is `'cloud-render'` or `'cloud-render-4k'`. |
| `job(id)` / `jobs()` | One job, or every job on the account. |
| `output(id)` | The rendered bytes. Throws unless the job is `done`. |
| `wait(id, { timeoutMs?, onState? })` | Polls to completion, then resolves with the bytes. |

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
