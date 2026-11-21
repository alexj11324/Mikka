# Plan 003: Stream the inline capture upload instead of buffering it

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- "app/v1/runs/[runId]/captures/[captureId]/route.ts"`
> On a mismatch with the excerpt below, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / availability
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

`PUT /v1/runs/:runId/captures/:captureId` writes the file inline when no bucket is configured. It reads `content-length` first (good), then does:

```ts
const bytes = new Uint8Array(await request.arrayBuffer())
if (bytes.length > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
```

`arrayBuffer()` buffers the **entire** body before the size check runs. When `content-length` is missing or wrong — chunked upload, a proxy that rewrites headers, a buggy client — the 4 MB `INLINE_UPLOAD_MAX_BYTES` limit never binds, and each concurrent request can push memory to the platform ceiling.

The caller is an authenticated device token, so this is not an anonymous DoS. It is a "compromised or misbehaving daemon credential / broken client" availability risk, and it decouples memory use from the run's declared quota.

The repo already has the correct pattern in two places; use it.

## Current state

`app/v1/runs/[runId]/captures/[captureId]/route.ts:19-29`:
```ts
/** `PUT /v1/runs/:runId/captures/:captureId`: the file itself, only where no bucket is configured. */
async function handlePUT(request: Request, { params }: { params: Promise<{ runId: string; captureId: string }> }) {
  const { runId, captureId } = await params
  const found = await deviceRun(request, runId, true)
  if (found instanceof Response) return found
  if (!z.uuid().safeParse(captureId).success) return captureJson({ error: 'Unknown capture.' }, 404)
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > INLINE_UPLOAD_MAX_BYTES) return captureJson({ error: 'Too large.' }, 413)
  const result = await receiveUpload(found.owner, captureId, bytes)
  return 'error' in result ? captureFailure(result) : new Response(null, { status: 204 })
}
```

The correct streaming pattern, `lib/coding-workspace/http.ts:16-35`:
```ts
const reader = request.body?.getReader()
if (!reader) throw new CodingWorkspaceError('workspace_invalid_request')
const parts: Uint8Array[] = []
let bytes = 0
try {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) { await reader.cancel(); throw new CodingWorkspaceError('workspace_limit_exceeded') }
    parts.push(value)
  }
  ...
} finally { reader.releaseLock() }
```

And `app/api/chat/attachments/route.ts:39-56` uses the same shape with `Buffer.concat(chunks)`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Capture DB suite | `node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/captures/store.db.test.ts` | all pass |
| Capture units | `node --import ./tests/support/server-only.mjs --import tsx --test lib/captures/captures.test.ts` | all pass |

## Scope

**In scope**:
- `app/v1/runs/[runId]/captures/[captureId]/route.ts` — `handlePUT` only
- `lib/captures/store.db.test.ts` — add a streaming-limit case (see Test plan)

**Out of scope**:
- `receiveUpload` / `beginUpload` in `lib/captures/store.ts` — the declared-size check there is correct and unrelated.
- `handlePOST` (the reservation reissue) — no body read.
- The chat-attachments and coding-workspace routes — they are already correct; do not touch them.

## Steps

### Step 1: Replace the buffered read with a bounded stream

Replace the two lines after the `content-length` check:

```ts
  // Read with a hard ceiling: a missing or wrong content-length must not let the
  // body buffer past the inline limit (the same shape as lib/coding-workspace/http.ts).
  const reader = request.body?.getReader()
  if (!reader) return captureJson({ error: 'Unreadable body.' }, 400)
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > INLINE_UPLOAD_MAX_BYTES) { await reader.cancel(); return captureJson({ error: 'Too large.' }, 413) }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = Buffer.concat(parts)
```

Then pass `bytes` to `receiveUpload` unchanged. `receiveUpload` expects a `Uint8Array`; `Buffer` is one, so no conversion is needed.

**Verify**: `grep -n "arrayBuffer" "app/v1/runs/[runId]/captures/[captureId]/route.ts"` returns nothing.

### Step 2: Confirm the 413 path still returns before any store write

Read the resulting `handlePUT` top to bottom. The order must be:
1. authenticate (`deviceRun`)
2. validate `captureId`
3. fast-reject on a declared `content-length`
4. stream with a hard ceiling
5. `receiveUpload`

**Verify**: by reading — no `receiveUpload` call may appear before the stream loop.

### Step 3: Run the capture suites

```sh
node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/captures/store.db.test.ts
node --import ./tests/support/server-only.mjs --import tsx --test lib/captures/captures.test.ts
```

**Verify**: all pass. In particular `store.db.test.ts` still asserts `beginUpload` rejects an over-limit declared size (`'too_large'`).

## Test plan

Add one case to `lib/captures/store.db.test.ts` near the existing inline-upload assertions (around line 458, next to the `Huge` case):

```ts
    // A body with no content-length cannot exceed the inline ceiling.
    const unbounded = await store.beginUpload(local, { title: 'Unbounded', contentType: 'image/png', size: PNG.length, sha256: sha(PNG) })
    assert.ok(!('error' in unbounded))
```

Then assert at the route level if the suite has a route harness; if it does not (check whether any test constructs a `Request` for this route), **skip the route-level test and record in the PR that the streaming path is covered by reading, not by a test** — do not invent a harness in this plan.

**Verify**: the suite passes and the new case is present.

## Done criteria

- [ ] No `arrayBuffer()` in the capture upload route
- [ ] The stream loop cancels the reader and returns 413 before buffering past `INLINE_UPLOAD_MAX_BYTES`
- [ ] `lib/captures/store.db.test.ts` passes
- [ ] `lib/captures/captures.test.ts` passes
- [ ] `git status` shows only the route file (and the test file if a case was added)

## STOP conditions

Stop and report if:
- `receiveUpload`'s signature expects something other than a `Uint8Array`/`Buffer` (the code drifted).
- `request.body` is already consumed before `handlePUT` (e.g. by middleware) — then streaming is impossible and the fix needs a different approach.
- The route has no `Request`-level test harness and you are tempted to build one; report instead.

## Maintenance notes

- If a bucket is configured this route is never used (`receiveUpload` returns `conflict`), so the change only affects inline deployments and tests.
- A reviewer should confirm the `content-length` fast path is still first: it avoids reading anything for the common oversized case.
- Follow-up: the same `arrayBuffer()` shape may exist in other upload routes; search `grep -rn "arrayBuffer()" app/` separately. Do not widen this plan.
