# Changelog

Every release is tagged and published from CI with npm provenance. Versions
follow semver; the embed protocol has its own version in the `ready` event.

## 0.2.0 - 2026-11-24

Added, all additive — 0.1.0 code keeps working:

- `create(request, { idempotencyKey })` — a job as JSON: a design, an uploaded
  bundle, or a tool over uploaded media, to one or several `outputs`.
- `batch(jobs, defaults)` — up to 100 jobs in one request.
- `compileDesign(design, vars)` and `renderDesign(design, request)`.
- `operations()` — every operation, its parameters, and the presets.
- `upload(data, { name, contentType })`, `asset(id)`, `deleteAsset(id)` —
  direct, chunked uploads used by id.
- `usage({ from, to, endUserId, groupBy })` and `deleteEndUser(endUserId)`.
- `embedToken(...)` — mint an embed session token server side.
- `destinations.*` — saved S3-compatible storage: list, create, update,
  delete, test, presign.
- `webhooks.*` — endpoints: list, create, update, delete, rotate,
  deliveries, test.
- `SnappedCut.verifyWebhook(secret, rawBody, header)` — checks
  `X-Snappedcut-Signature` with Web Crypto.
- `render()` takes `idempotencyKey` and `priority`; `output()` and `wait()`
  take an output `index` for multi-output jobs.
- Types: `JobRequest`, `OutputRequest`, `Design`, `DesignClip`, `Created`,
  `Asset`, `JobOutput`, `Destination`, `WebhookEndpoint`,
  `StorageDestination`, and new optional `Job` fields.

## 0.1.0 - 2026-11-24

First publish.

