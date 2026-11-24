/**
 * The Snapped Cut client.
 *
 * **`fetch`, and nothing else.** No dependencies, so it runs unchanged in Node,
 * a browser, Deno, a Worker and a CI job. The API is five endpoints; a client
 * for it should be readable in one sitting, and this one is.
 *
 * ```ts
 * const snapcut = new SnappedCut({ key: process.env.SNAPCUT_KEY });
 * const job = await snapcut.render(bundleBytes);
 * const file = await snapcut.wait(job.id);
 * ```
 *
 * Note: the ceiling is that this only covers the *server* API — the cloud
 * render queue and the account behind it. Everything else Snapped Cut does happens
 * in a browser, and an SDK cannot make Node run WebCodecs. `@snappedcut/mcp`
 * drives the real editor for that, and this is deliberately not that.
 */

export type SnappedCutOptions = {
  /**
   * An API key from the account page. `sk_snapcut_…`.
   *
   * Omit it *only* in a browser on the site itself: the editor's own cloud
   * render runs same-origin, where the session cookie already authenticates
   * and minting a key to call ourselves would be a second credential to leak.
   * Anywhere else a missing key is a 401 from the first request.
   */
  readonly key?: string;
  /** Where the server is. Override for a self-hosted install. */
  readonly base?: string;
  readonly fetch?: typeof fetch;
};

export type JobKind = 'cloud-render' | 'cloud-render-4k';
export type JobState = 'queued' | 'running' | 'done' | 'failed';

export type Job = {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly error: string | null;
  readonly seconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ready?: boolean;
};

/** What the server decided the job was, and therefore what it cost. */
export type Priced = {
  readonly seconds: number;
  readonly project: string;
  readonly layers: number;
};

export type AccountSummary = {
  readonly id: string;
  readonly email: string;
  readonly credits: number;
  readonly prices: Readonly<Record<string, number>>;
};

/**
 * A refusal from the server, with its status.
 *
 * A distinct class because the two failures a caller actually branches on —
 * "no credits" (402) and "slow down" (429) — are not exceptional and should be
 * catchable without parsing a message.
 */
/**
 * How much of a bundle goes in one request.
 *
 * Cloudflare's free plan refuses a proxied request body over 100 MB, and the
 * site is behind it, so a 512 MB bundle cannot be one POST however well it
 * streams. 64 MiB leaves room for headers and for a tighter cap on some other
 * proxy without making the chunk count silly.
 */
const CHUNK = 64 * 1024 * 1024;

type Queued = { job: Job; charged: number; credits: number; priced: Priced };

/**
 * One slice of the bundle, without copying it.
 *
 * `Blob.slice` and `TypedArray.subarray` are both views, which matters when the
 * whole thing is half a gigabyte: building each chunk with `new Uint8Array(...)`
 * would copy 64 MiB per request for no reason.
 */
function part(bundle: Uint8Array | ArrayBuffer | Blob, from: number, to: number): BodyInit {
  if (bundle instanceof Blob) return bundle.slice(from, to);
  if (bundle instanceof Uint8Array) return bundle.subarray(from, to) as BodyInit;
  return new Uint8Array(bundle, from, to - from) as BodyInit;
}

export class SnappedCutError extends Error {
  /* Assigned in the body rather than declared as constructor parameter
     properties: those are the one piece of TypeScript that is not erasable, so
     they would stop Node from running this file directly — which is exactly how
     `@snappedcut/mcp` loads it. */
  readonly status: number;
  readonly retryAfterMs: number;
  /** On a 409 from a chunked upload: the byte the server's copy ends at. */
  readonly expected: number;

  constructor(message: string, status: number, retryAfterMs = 0, expected = 0) {
    super(message);
    this.name = 'SnappedCutError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.expected = expected;
  }

  /** Out of credits. Buy more, or render locally. */
  get outOfCredits(): boolean {
    return this.status === 402;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export class SnappedCut {
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(options: SnappedCutOptions = {}) {
    this.#key = options.key ?? '';
    /* Same-origin when there is no key, because that is the only case where
       omitting one works at all — a keyless client pointed at the public host
       from somewhere else is just a 401 generator. */
    const fallback = this.#key ? 'https://snappedcut.com' : '';
    this.#base = (options.base ?? fallback).replace(/\/$/, '');
    // Injectable so a test does not need a server, and bound because an
    // unbound `fetch` throws "illegal invocation" in a browser.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        ...(this.#key ? { authorization: `Bearer ${this.#key}` } : {}),
      },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        retryAfterMs?: number;
        expected?: number;
      };
      throw new SnappedCutError(
        body.error ?? `Snapped Cut said ${response.status}.`,
        response.status,
        body.retryAfterMs ?? 0,
        body.expected ?? 0,
      );
    }
    return response;
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.#call(path, init)).json() as Promise<T>;
  }

  /** The account behind the key: who, and how many credits are left. */
  async account(): Promise<AccountSummary> {
    return this.#json<AccountSummary>('/api/account');
  }

  /**
   * Queues a render.
   *
   * The bundle is the whole request body — no multipart, so a large bundle
   * streams rather than being assembled in memory at both ends.
   *
   * There is no `seconds` parameter and there should not be: the server reads
   * the timeline duration out of the bundle's own `project.json` and prices on
   * that. A duration supplied by the caller is a price supplied by the caller.
   * What it was charged for comes back in `priced`.
   */
  async render(
    bundle: Uint8Array | ArrayBuffer | Blob,
    options: { kind?: JobKind } = {},
  ): Promise<Job & { charged: number; credits: number; priced: Priced }> {
    const kind = options.kind ?? 'cloud-render';
    const size = bundle instanceof Blob ? bundle.size : bundle.byteLength;

    if (size <= CHUNK) {
      const body = await this.#json<Queued>(`/api/jobs?kind=${encodeURIComponent(kind)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: part(bundle, 0, size),
      });
      return { ...body.job, charged: body.charged, credits: body.credits, priced: body.priced };
    }

    let upload = '';
    let offset = 0;
    let attempts = 0;

    while (offset < size) {
      const to = Math.min(size, offset + CHUNK);
      const last = to === size;

      const query = new URLSearchParams({ kind, offset: String(offset) });
      if (upload) query.set('upload', upload);
      if (last) query.set('final', '1');

      try {
        const response = await this.#call(`/api/jobs?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: part(bundle, offset, to),
        });

        if (last) {
          const body = (await response.json()) as Queued;
          return {
            ...body.job,
            charged: body.charged,
            credits: body.credits,
            priced: body.priced,
          };
        }

        // The server's count, not ours: it is the one with the file.
        const body = (await response.json()) as { upload: string; received: number };
        upload = body.upload;
        offset = body.received;
        attempts = 0;
      } catch (error) {
        const status = error instanceof SnappedCutError ? error.status : 0;
        if ((attempts += 1) > 3) throw error;

        // Where the server says its copy ends. Believe it over our own count.
        if (status === 409) {
          offset = (error as SnappedCutError).expected;
          continue;
        }
        // A refusal is a refusal — no credits, bad bundle, bad key. Only a lost
        // connection (0) or a server fault (5xx) is worth sending again.
        if (status !== 0 && status < 500) throw error;
      }
    }

    throw new SnappedCutError('That upload ended without queueing a job.', 0);
  }

  async job(id: string): Promise<Job> {
    return this.#json<Job>(`/api/jobs/${encodeURIComponent(id)}`);
  }

  async jobs(): Promise<Job[]> {
    return (await this.#json<{ jobs: Job[] }>('/api/jobs')).jobs;
  }

  /** The rendered file. Throws if the job is not done. */
  async output(id: string): Promise<Uint8Array> {
    const response = await this.#call(`/api/jobs/${encodeURIComponent(id)}/output`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Waits for a job to finish, then hands back the file.
   *
   * Polls with a backoff rather than at a fixed interval: a render is minutes,
   * so a one-second poll spends most of its requests learning nothing, and the
   * server has a rate limit that a busy loop will find.
   */
  async wait(
    id: string,
    options: { timeoutMs?: number; onState?: (job: Job) => void } = {},
  ): Promise<Uint8Array> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    let wait = 1000;

    for (;;) {
      const job = await this.job(id);
      options.onState?.(job);

      if (job.state === 'done') return this.output(id);
      // The credits are already back — `fail()` refunds — so this is a plain
      // error, not something the caller has to reconcile.
      if (job.state === 'failed') throw new SnappedCutError(job.error ?? 'The render failed.', 500);
      if (Date.now() > deadline) throw new SnappedCutError(`Job ${id} is still ${job.state}.`, 504);

      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 1.5, 15_000);
    }
  }
}

export default SnappedCut;
