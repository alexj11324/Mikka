# Plan 008: Batch link-preview reads

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- components/workspace/agent-citations.tsx app/actions/link-preview.ts`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: performance
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

Opening a thread with N external links issues **N separate server-action calls**. Each one goes over `/api/rpc` (one POST per action), and each server-side call does `await requireUser()` plus a DNS `lookup` and up to three `fetch` hops.

Worse, the SWR key is `['link-previews', ...urls]`, so when a streaming reply adds one more link, **every** previous URL is refetched.

The repo already has the correct pattern next door: `lib/message-reactions.ts:10` defines `REACTION_IDS_PER_REQUEST = 100` and chunks ids into batched URLs. Link previews never got it.

## Current state

`components/workspace/agent-citations.tsx:84-90`:
```ts
export function useLinkPreviews(texts: readonly string[]): LinkPreviews {
  const urls = [...new Set(texts.flatMap(text => splitCitations(text).flatMap(part => part.type === 'link' ? [part.url] : [])))].sort()
  const { data = NO_PREVIEWS } = useSWR<LinkPreviews>(urls.length ? ['link-previews', ...urls] : null, async () => {
    const results = await Promise.all(urls.map(url => getLinkPreview(url).catch(() => null)))
    return Object.fromEntries(urls.map((url, index) => [url, results[index]]))
  }, { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  return data
}
```

`app/actions/link-preview.ts` (whole file):
```ts
'use server'

import { requireUser } from '@/lib/issue-access'
import { linkPreview, type LinkPreview } from '@/lib/link-preview'

/** The preview for a link in the person's Coordinator chat. Signed-in people only, so this is no open proxy. */
export async function getLinkPreview(url: string): Promise<LinkPreview | null> {
  await requireUser()
  if (typeof url !== 'string' || url.length > 2000) return null
  return linkPreview(url)
}
```

`lib/link-preview.ts:69` — `export function linkPreview(url: string): Promise<LinkPreview | null>`

The batching precedent, `lib/message-reactions.ts:10-23`:
```ts
export const REACTION_IDS_PER_REQUEST = 100
export function reactionUrls(messageIds) { /* chunks of 100 → urls[] */ }
```

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Link-preview units | `node --import tsx --test lib/link-preview.test.ts` | pass |
| Citation units | `node --import tsx --test lib/agent-citations.test.ts` (if present) | pass |
| UI policy | `node scripts/lint-ui.mjs` | 0 errors |

## Scope

**In scope**:
- `app/actions/link-preview.ts` — add a batched action
- `components/workspace/agent-citations.tsx` — call it in chunks

**Out of scope**:
- `lib/link-preview.ts` — the per-URL implementation stays.
- Removing `getLinkPreview` — other callers may exist; check `grep -rn "getLinkPreview" components app` and keep it if any remain.
- The server-side 6-hour cache — it already works; this plan is about transport calls.

## Steps

### Step 1: Check who else calls `getLinkPreview`

```sh
grep -rn "getLinkPreview" components app lib --include='*.ts' --include='*.tsx' | grep -v "link-preview.ts"
```

**Verify**: record the list. If only `agent-citations.tsx` uses it, you may replace it; if others use it, keep it and add the batch alongside.

### Step 2: Add a batched action

In `app/actions/link-preview.ts`, add:

```ts
/** Previews for several links in one round trip. One `requireUser`, one DNS per
 * distinct host at most; a batch is capped so a huge thread cannot become a
 * single slow action. */
export const LINK_PREVIEWS_PER_REQUEST = 50

export async function getLinkPreviews(urls: readonly string[]): Promise<Record<string, LinkPreview | null>> {
  await requireUser()
  const unique = [...new Set(urls)].filter(url => typeof url === 'string' && url.length <= 2000).slice(0, LINK_PREVIEWS_PER_REQUEST)
  const results = await Promise.all(unique.map(url => linkPreview(url).catch(() => null)))
  return Object.fromEntries(unique.map((url, index) => [url, results[index]]))
}
```

**Verify**: `grep -n "getLinkPreviews" app/actions/link-preview.ts` → present.

### Step 3: Chunk the client

Replace the SWR fetcher in `agent-citations.tsx`:

```ts
const PREVIEWS_PER_CALL = 50

export function useLinkPreviews(texts: readonly string[]): LinkPreviews {
  const urls = [...new Set(texts.flatMap(text => splitCitations(text).flatMap(part => part.type === 'link' ? [part.url] : [])))].sort()
  // One key per chunk: a reply that adds one link refetches only its own chunk,
  // not every earlier URL (the batching shape lib/message-reactions.ts uses).
  const chunks = useMemo(() => {
    const out: string[][] = []
    for (let start = 0; start < urls.length; start += PREVIEWS_PER_CALL) out.push(urls.slice(start, start + PREVIEWS_PER_CALL))
    return out
  }, [urls.join('\u0000')])
  const { data = NO_PREVIEWS } = useSWR<LinkPreviews>(chunks.length ? ['link-previews', ...chunks.map(chunk => chunk.join('\u0000'))] : null, async () => {
    const results = await Promise.all(chunks.map(chunk => getLinkPreviews(chunk).catch(() => ({} as Record<string, LinkPreview | null>))))
    return Object.assign({}, ...results)
  }, { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  return data
}
```

Add `useMemo` to the React import if it is not already there, and `LinkPreview` to the type import from `@/lib/link-preview`.

> **Note on the `useMemo` dependency**: `urls` is a fresh array each render. The `urls.join('\u0000')` dependency is the stable identity; use it exactly as written. If the file already has a helper for this pattern (search `useMemo` in the same file), use that instead.

**Verify**: `grep -n "getLinkPreviews" components/workspace/agent-citations.tsx` → present; `grep -c "getLinkPreview(" components/workspace/agent-citations.tsx` → 0 (the singular form is gone).

### Step 4: Run the gates

```sh
node scripts/lint-ui.mjs
node --import tsx --test lib/link-preview.test.ts
```

**Verify**: `0 errors`; tests pass.

## Test plan

- **New**: a unit test for the chunking helper if you extract one (recommended: put the chunk function next to `LINK_PREVIEWS_PER_REQUEST` and test that 120 URLs become 3 chunks and a duplicate URL appears once).
- **Structural pattern**: `lib/message-reactions.ts`'s `reactionUrls` — mirror it.
- **Must not regress**: the citation rendering itself. `node --import tsx --test components/workspace/agent-citations.test.tsx` if it exists.

## Done criteria

- [ ] `getLinkPreviews` exists and caps at 50 per call
- [ ] `agent-citations.tsx` no longer calls the singular action per URL
- [ ] The SWR key is chunk-shaped, so adding one link does not refetch every earlier chunk
- [ ] `node scripts/lint-ui.mjs` reports 0 errors
- [ ] `lib/link-preview.test.ts` passes

## STOP conditions

Stop and report if:
- Another caller uses `getLinkPreview` in a way this plan would break (Step 1 reveals it).
- `lib/link-preview.ts`'s `linkPreview` already dedupes by host internally — then the DNS concern is smaller than stated and the batching is still worth it for the RPC count, but say so in the PR.
- The `useMemo` dependency pattern conflicts with an existing lint rule in this file.

## Maintenance notes

- The 50-per-call cap is a transport guard, not a product limit: a thread with more than 50 distinct external links gets previews for the first 50 in sort order. That is a deliberate, recorded trade-off; if it matters, a follow-up can paginate.
- A reviewer should confirm the SWR key still changes when the URL **set** changes, and does not change when the array is re-created with the same contents.
