# Plan 004: Mask workspace secrets in Factory persisted text

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- lib/factory/note-mask.ts lib/factory/handoff.ts lib/factory/store.ts lib/factory/public-task.ts lib/factory/spec-artifact.ts`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

Factory persists free text in several places that later reach a **model prompt** and the **UI**: the handoff event, `factory_tasks.reason`, the spec artifact body, capture titles, activity lines. `maskFactoryNote` is the single masking gate for all of it.

That gate is a reduced copy of the real masker. Its server-secret list is one entry:

```ts
/** Server secrets that #438's masker also always masks. */
const SERVER_SECRET_ENV = ["E2B_API_KEY"] as const;
```

The file's own TODO admits the gap (`lib/factory/note-mask.ts:36-40`): it does not handle per-character `%xx`/`\uXXXX` encoding, double URL encoding, nested JSON escaping, base64 at a non-3-byte offset, base64 inside base64, `{"GITHUB_TOKEN":"..."}` JSON form, or provider tokens such as `AKIA…`, JWTs, `xoxb-`.

The real masker already exists and is used everywhere else on the same paths — diffs, captures, subagent events, terminal:

```ts
// lib/secrets/runtime.ts:244
export async function workspaceSecretMasker(workspaceId: string | null | undefined, env = process.env): Promise<Masker>
// lib/secrets/runtime.ts:257
export async function secretMaskerFor(target: { workspaceId; ownerId?: string | null }, env = process.env): Promise<Masker>
```

So a person who pastes a third-party credential with no recognisable prefix (a database password, an internal service token) into a Factory note — or whose agent writes it into a plan, report or title — gets it stored in plaintext in `factory_events`, `factory_tasks.reason` and the spec artifact, and re-injected into the next run's prompt. Every other exit on the same path masks it.

## Current state

`lib/factory/note-mask.ts:41` — the current signature is synchronous and takes an optional secret list:

```ts
export function maskFactoryNote(text: string, secrets: readonly NoteSecret[] = serverNoteSecrets()): string
```

Call sites (all of them — verified by `grep -rn "maskFactoryNote" lib | grep -v test`):

| File | Line | What it masks |
|---|---|---|
| `lib/factory/handoff.ts` | `:11` (`sanitize`) | every string written to `factory_events` and copied into the next prompt |
| `lib/factory/store.ts` | `:481` | `factory_tasks.reason` |
| `lib/factory/public-task.ts` | `:9` | `task.reason` returned to the UI |
| `lib/factory/spec-artifact.ts` | `:32`, `:44`, `:115`, `:117` | spec body, title, author name |
| `lib/factory/task-media.ts` | `:47` | capture title |
| `lib/factory/activity.ts` | `:17` | activity line text |
| `lib/factory/activity-artifacts.ts` | `:101` | document title |
| `lib/factory/attempt-view.ts` | `:42` | first line of an attempt's source |
| `lib/factory/route-http.ts` | `:25`, `:28` | response rationale and string lists |
| `lib/factory/http.ts` | `:86`, `:87` | `reason` on approve/reject |
| `lib/factory/approval.ts` | `:656` | approval `note` |
| `lib/factory/dispatch.ts` | `:61` | dispatch `note` |
| `lib/factory/questions/ask-user.ts` | `:28`, `:35`, `:36` | recorded answer and question text |

Existing test: `lib/factory/note-mask.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Note-mask units | `node --import tsx --test lib/factory/note-mask.test.ts` | all pass |
| Factory DB suite | `node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/factory/store.db.test.ts` | all pass (needs PG17) |
| Typecheck | **do not run on a Mac** — CI proves it | — |

## Scope

**In scope**:
- `lib/factory/note-mask.ts` — make the masker injectable
- `lib/factory/note-mask.test.ts` — new cases
- The call sites listed above, **only** to thread the masker through

**Out of scope**:
- `lib/secrets/runtime.ts` — do not change `workspaceSecretMasker` / `secretMaskerFor`.
- `lib/factory/checks.ts:718-735` (`redactFactoryCheckText`) — it is a different layer (check output), already correct, and `maskFactoryNote` still calls it last.
- Any change to what is persisted or its shape.

## Steps

### Step 1: Write the failing test first

In `lib/factory/note-mask.test.ts`, add a case that proves a workspace secret survives today:

```ts
test('a workspace secret is masked in a Factory note', async () => {
  const value = 'postgres://user:sup3rs3cr3t@db.internal/app'
  const masked = maskFactoryNote(`deploy failed: ${value}`, [{ name: 'DATABASE_URL', value }])
  assert.ok(!masked.includes('sup3rs3cr3t'), masked)
  assert.ok(masked.includes('[secret]'), masked)
})
```

**Verify**: this passes already (the explicit `secrets` argument works). That is the point — it proves the injection point is sound, and the real gap is that **no call site passes workspace secrets**.

Now add the case that fails:

```ts
test('a workspace secret is masked without an explicit list once a masker is given', async () => {
  const value = 'sk-live-abcdef123456'
  const masked = maskFactoryNote(`key=${value}`, { mask: text => text.replaceAll(value, '[secret]') })
  assert.ok(!masked.includes(value), masked)
})
```

**Verify**: fails to compile or run — `maskFactoryNote` does not accept a `Masker` yet.

### Step 2: Accept a `Masker` in `maskFactoryNote`

Change the signature to accept an optional `Masker` (import the type from `lib/secrets/mask` or wherever `Masker` is declared — check `lib/secrets/runtime.ts:244`'s return type):

```ts
import type { Masker } from '@/lib/secrets/mask'

export function maskFactoryNote(text: string, extra?: Masker | readonly NoteSecret[]): string {
  // A resolved Masker (the workspace's saved secrets plus credential patterns) wins:
  // it is the same gate every other Factory-adjacent exit already uses.
  if (extra && !Array.isArray(extra)) {
    return redactFactoryCheckText(extra.mask(text))
  }
  const secrets = Array.isArray(extra) ? extra : serverNoteSecrets()
  ... // existing body unchanged
}
```

Keep the existing `NoteSecret[]` path intact so the current tests and the sync call sites keep working.

**Verify**: `node --import tsx --test lib/factory/note-mask.test.ts` — all pass, including the new one.

### Step 3: Thread the workspace masker through the highest-value call sites

Do **not** convert all 13 call sites in one go. Convert the four that reach a **prompt** or the **UI**, and leave the rest on the existing path with a `// TODO(#438)` comment:

1. `lib/factory/handoff.ts:11` — `sanitize` is used for `factory_events`. Make it accept a masker:
   ```ts
   function sanitize(value: unknown, mask: Masker): unknown {
     if (typeof value === 'string') return mask.mask(value).slice(0, 10000)
     ...
   }
   ```
   and pass the masker down from the caller that already has the task (it has `task.workspaceId` and `task.userId`).
2. `lib/factory/store.ts:481` — `factory_tasks.reason`.
3. `lib/factory/public-task.ts:9` — the reason the UI shows.
4. `lib/factory/spec-artifact.ts:32` — the spec body.

At each site, resolve the masker once per call:
```ts
const mask = await secretMaskerFor({ workspaceId: task.workspaceId, ownerId: task.userId })
```

**Verify**: `grep -n "secretMaskerFor" lib/factory/handoff.ts lib/factory/store.ts lib/factory/public-task.ts lib/factory/spec-artifact.ts` → one hit each.

### Step 4: Prove no call site is left unmasked on the prompt path

```sh
grep -rn "maskFactoryNote\|sanitize(" lib/factory/handoff.ts
```

**Verify**: every string that reaches `factory_events` goes through the masker-taking `sanitize`.

### Step 5: Run the suites

```sh
node --import tsx --test lib/factory/note-mask.test.ts
node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/factory/store.db.test.ts
```

**Verify**: all pass.

## Test plan

- **New**: workspace secret masked without an explicit list (Step 1).
- **New**: an event written through `persistFactoryHandoff` with a secret in its payload reads back masked — add this to whichever DB suite covers handoff (`lib/factory/store.db.test.ts` or `handoff`'s own suite; search `grep -rln "persistFactoryHandoff" lib/factory/*.test.ts`).
- **Must not regress**: `lib/factory/note-mask.test.ts`'s existing cases (provider token patterns, `NAME_KEY=value`).

## Done criteria

- [ ] `maskFactoryNote` accepts a `Masker` and the `NoteSecret[]` path still works
- [ ] The four prompt/UI call sites pass a workspace-resolved masker
- [ ] A new test proves a workspace secret is masked without an explicit list
- [ ] `lib/factory/note-mask.test.ts` and `lib/factory/store.db.test.ts` pass
- [ ] No behaviour change to what is persisted (same columns, same limits)

## STOP conditions

Stop and report if:
- `Masker` is not a stable exported type (check its declaration; if it is inline in a function return type, report rather than inventing an export).
- Any of the four call sites does not have a `task` with `workspaceId`/`userId` in scope — report which, rather than threading a parameter through five layers.
- Converting `sanitize` to async breaks a synchronous caller (check every caller of `sanitize` in `handoff.ts`).
- A DB suite asserts the exact persisted string of a reason that contains a secret-like value (the mask would change it).

## Maintenance notes

- The remaining nine call sites still use `serverNoteSecrets()`. That is a known, recorded gap; the TODO in `note-mask.ts` should be updated to say which sites are converted and which are not.
- A reviewer should confirm the masker is resolved from the **task's** tenant (`task.workspaceId`/`task.userId`), not from the ambient request, so a background job masks correctly.
- Follow-up: delete `SERVER_SECRET_ENV` entirely once all call sites take a masker.
