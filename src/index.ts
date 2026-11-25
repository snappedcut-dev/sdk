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
  readonly priority?: Priority;
  readonly idempotencyKey?: string | null;
  readonly credits?: number | null;
  readonly outputs?: readonly JobOutput[];
};

export type Priority = 'interactive' | 'background';
export type Format = 'mp4' | 'webm' | 'mkv' | 'mov';

export type JobOutput = {
  readonly index: number;
  readonly key: string | null;
  readonly format: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly url: string;
  readonly location?: string;
  readonly delivered?: boolean;
  readonly deliveryError?: string;
};

export type Destination =
  | { readonly type: 'presigned-put'; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
  | { readonly type: 'saved'; readonly id: string };

/** One render of a job. Size by preset, width+height, targetWidth or scale. */
export type OutputRequest = {
  readonly format?: Format;
  readonly preset?: string;
  readonly width?: number;
  readonly height?: number;
  readonly targetWidth?: number;
  readonly scale?: number;
  readonly fit?: 'contain' | 'cover';
  readonly quality?: number | 'low' | 'medium' | 'high' | 'very-high' | 'master';
  readonly key?: string;
  readonly destination?: Destination;
};

/** A clip in a design. `x`, `y` are pixels from the frame's centre. */
export type DesignClip = {
  readonly type: 'video' | 'audio' | 'image' | 'text' | 'shape';
  readonly asset?: string;
  readonly url?: string;
  readonly start?: number;
  readonly duration?: number;
  readonly from?: number;
  readonly track?: number;
  readonly [field: string]: unknown;
};

export type Design = {
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly background?: string;
  readonly duration?: number;
  readonly clips: readonly DesignClip[];
};

/** A job described in JSON: a design, an uploaded bundle, or a tool over uploaded media. */
export type JobRequest = OutputRequest & {
  readonly kind?: 'cloud-render' | 'tool';
  readonly design?: Design;
  readonly vars?: Readonly<Record<string, string | number>>;
  readonly bundle?: string;
  readonly tool?: string;
  readonly inputs?: readonly string[];
  readonly params?: Readonly<Record<string, unknown>>;
  readonly outputs?: readonly OutputRequest[];
  readonly priority?: Priority;
  readonly idempotencyKey?: string;
};

export type Created = { readonly job: Job; readonly charged: number; readonly price: number; readonly credits: number | null; readonly idempotent?: boolean };

export type Asset = {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly hasAudio: boolean | null;
  readonly confirmed: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export type WebhookEvent = 'job.succeeded' | 'job.failed' | 'session.ended';
export type WebhookEndpoint = { readonly id: string; readonly url: string; readonly events: readonly WebhookEvent[]; readonly enabled: boolean; readonly createdAt: number };
export type StorageDestination = { readonly id: string; readonly name: string; readonly endpoint: string; readonly region: string; readonly bucket: string; readonly prefix: string; readonly pathStyle: boolean; readonly accessKeyId: string; readonly createdAt: number; readonly updatedAt: number };
export type UsageGroup = 'day' | 'week' | 'month' | 'endUser' | 'key' | 'operation';

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
    options: { kind?: JobKind; idempotencyKey?: string; priority?: Priority } = {},
  ): Promise<Job & { charged: number; credits: number; priced: Priced }> {
    const kind = options.kind ?? 'cloud-render';
    const lane = options.priority ? `&priority=${options.priority}` : '';
    const idem: Record<string, string> = options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {};
    const size = bundle instanceof Blob ? bundle.size : bundle.byteLength;

    if (size <= CHUNK) {
      const body = await this.#json<Queued>(`/api/jobs?kind=${encodeURIComponent(kind)}${lane}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip', ...idem },
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

      const query = new URLSearchParams({ kind, offset: String(offset), ...(options.priority ? { priority: options.priority } : {}) });
      if (upload) query.set('upload', upload);
      if (last) query.set('final', '1');

      try {
        const response = await this.#call(`/api/jobs?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/zip', ...(last ? idem : {}) },
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

  /** POST /api/jobs as JSON. An Idempotency-Key makes a retry return the first job instead of a second charge. */
  async create(request: JobRequest, options: { idempotencyKey?: string } = {}): Promise<Created> {
    const key = options.idempotencyKey ?? request.idempotencyKey;
    return this.#json<Created>('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(request),
    });
  }

  /** Up to 100 jobs; `defaults` is merged under each. Each item is answered on its own. */
  async batch(jobs: readonly JobRequest[], defaults?: JobRequest): Promise<{ accepted: number; refused: number; jobs: readonly (Partial<Created> & { index: number; status: number; error?: string })[] }> {
    return this.#post('/api/jobs/batch', { jobs, ...(defaults ? { defaults } : {}) });
  }

  /** Compiles a design to the editor's project.json without rendering it. */
  async compileDesign(design: Design, vars?: JobRequest['vars']): Promise<{ project: unknown; seconds: number; size: { width: number; height: number }; assets: string[] }> {
    return this.#post('/api/designs', { design, ...(vars ? { vars } : {}) });
  }

  async renderDesign(design: Design, request: Omit<JobRequest, 'design'> = {}, options: { idempotencyKey?: string } = {}): Promise<Created> {
    return this.create({ ...request, design }, options);
  }

  /** Every operation, the render parameters, and the presets. */
  async operations(): Promise<{ operations: readonly { id: string; kind: string; billed: boolean; params: Record<string, unknown> }[]; presets: readonly { id: string; label: string; size: { width: number; height: number } | null }[] }> {
    return this.#json('/api/operations');
  }

  /**
   * Uploads media (or a bundle) once, for use by id in designs, tools and
   * jobs. Sent in chunks under the CDN's per-request cap, then confirmed.
   */
  async upload(data: Uint8Array | ArrayBuffer | Blob, options: { name?: string; contentType: string }): Promise<Asset> {
    const made = await this.#post<{ assetId: string; upload: { url: string; maxChunkBytes: number } }>('/api/uploads', options);
    const size = data instanceof Blob ? data.size : data.byteLength;
    const step = made.upload.maxChunkBytes;
    for (let offset = 0; offset < size || offset === 0; offset += step) {
      const to = Math.min(size, offset + step);
      // The upload URL carries its own permission; our key is not sent to it.
      const response = await this.#fetch(`${made.upload.url}&offset=${offset}`, { method: 'PUT', headers: { 'content-type': options.contentType }, body: part(data, offset, to) });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new SnappedCutError(body.error ?? `The upload said ${response.status}.`, response.status);
      }
      if (to >= size) break;
    }
    return (await this.#post<{ asset: Asset }>(`/api/uploads/${made.assetId}/confirm`, {})).asset;
  }

  async asset(id: string): Promise<Asset> {
    return (await this.#json<{ asset: Asset }>(`/api/uploads/${encodeURIComponent(id)}`)).asset;
  }

  async deleteAsset(id: string): Promise<void> {
    await this.#call(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async usage(query: { from?: number; to?: number; endUserId?: string; groupBy?: UsageGroup } = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.#json(`/api/usage?${params}`);
  }

  /** Deletes one end user's renders and uploads, and their id from everything we keep. */
  async deleteEndUser(endUserId: string): Promise<Record<string, number | string>> {
    return this.#json(`/api/usage?endUserId=${encodeURIComponent(endUserId)}`, { method: 'DELETE' });
  }

  /** Mints an embed session token for one of your end users. Server side: needs your secret key. */
  async embedToken(request: { pk: string; endUserId: string; maxCredits?: number; ttlSeconds?: number; origin?: string; features?: Record<string, unknown> }): Promise<{ token: string; sessionId: string; expiresAt: number; maxCredits: number; mode: string }> {
    return this.#post('/api/embed/tokens', request);
  }

  readonly destinations = {
    list: async (): Promise<StorageDestination[]> => (await this.#json<{ destinations: StorageDestination[] }>('/api/destinations')).destinations,
    create: async (input: { name: string; endpoint: string; region?: string; bucket: string; prefix?: string; accessKeyId: string; secretAccessKey: string; pathStyle?: boolean }): Promise<StorageDestination> =>
      (await this.#post<{ destination: StorageDestination }>('/api/destinations', input)).destination,
    update: async (id: string, patch: Record<string, unknown>): Promise<StorageDestination> =>
      (await this.#json<{ destination: StorageDestination }>(`/api/destinations/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).destination,
    delete: async (id: string): Promise<void> => void (await this.#call(`/api/destinations/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    test: async (id: string): Promise<{ ok: boolean; key: string; error: string | null }> => {
      // A failed write is an answer here, not an exception.
      const response = await this.#fetch(`${this.#base}/api/destinations/${encodeURIComponent(id)}/test`, { method: 'POST', headers: this.#key ? { authorization: `Bearer ${this.#key}` } : {} });
      return response.json() as Promise<{ ok: boolean; key: string; error: string | null }>;
    },
    presign: async (id: string, key: string, expiresIn?: number): Promise<{ method: 'PUT'; url: string; key: string; expiresAt: number }> =>
      this.#post(`/api/destinations/${encodeURIComponent(id)}/presign`, { key, ...(expiresIn ? { expiresIn } : {}) }),
  };

  readonly webhooks = {
    list: async (): Promise<WebhookEndpoint[]> => (await this.#json<{ webhooks: WebhookEndpoint[] }>('/api/webhooks')).webhooks,
    /** The secret comes back this once. */
    create: async (url: string, events?: readonly WebhookEvent[]): Promise<{ webhook: WebhookEndpoint; secret: string }> => this.#post('/api/webhooks', { url, ...(events ? { events } : {}) }),
    update: async (id: string, patch: { url?: string; events?: readonly WebhookEvent[]; enabled?: boolean }): Promise<WebhookEndpoint> =>
      (await this.#json<{ webhook: WebhookEndpoint }>(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).webhook,
    delete: async (id: string): Promise<void> => void (await this.#call(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    rotate: async (id: string): Promise<string> => (await this.#post<{ secret: string }>(`/api/webhooks/${encodeURIComponent(id)}/rotate`, {})).secret,
    deliveries: async (id: string, limit = 50): Promise<Record<string, unknown>[]> =>
      (await this.#json<{ deliveries: Record<string, unknown>[] }>(`/api/webhooks/${encodeURIComponent(id)}/deliveries?limit=${limit}`)).deliveries,
    test: async (id: string): Promise<{ eventId: string }> => this.#post(`/api/webhooks/${encodeURIComponent(id)}/test`, {}),
  };

  /**
   * Checks an `X-Snappedcut-Signature` header against the raw body. Web Crypto,
   * so it runs in Node 18+, Deno, Bun, workers and browsers alike.
   */
  static async verifyWebhook(secret: string, rawBody: string, header: string | null, now = Date.now()): Promise<boolean> {
    const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.split('=') as [string, string]));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(now - t) > 5 * 60_000 || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
    const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ parts.v1!.charCodeAt(i);
    return diff === 0;
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    return this.#json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async job(id: string): Promise<Job> {
    return this.#json<Job>(`/api/jobs/${encodeURIComponent(id)}`);
  }

  async jobs(): Promise<Job[]> {
    return (await this.#json<{ jobs: Job[] }>('/api/jobs')).jobs;
  }

  /** The rendered file. Throws if the job is not done. */
  async output(id: string, index = 0): Promise<Uint8Array> {
    const response = await this.#call(`/api/jobs/${encodeURIComponent(id)}/output${index ? `?index=${index}` : ''}`);
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
    options: { timeoutMs?: number; onState?: (job: Job) => void; index?: number } = {},
  ): Promise<Uint8Array> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    let wait = 1000;

    for (;;) {
      const job = await this.job(id);
      options.onState?.(job);

      if (job.state === 'done') return this.output(id, options.index ?? 0);
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
