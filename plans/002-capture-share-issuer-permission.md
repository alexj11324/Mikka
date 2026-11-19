# Plan 002: Make capture share links follow the issuer's current permission

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If anything in "STOP conditions" happens, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- lib/captures/store.ts lib/captures/store.db.test.ts`
> If either file changed, compare the excerpts below against live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

A capture share link (`/api/captures/shared/:token`) is readable **with no session at all** — anyone holding the URL gets the bytes. Captures are screenshots and screen recordings of the code and UI under review.

`sharedCapture` decides access from the token alone. It never re-checks whether the person who created the link still has any right to that capture. The sibling implementation for Artifacts already does the right thing, with a comment stating the policy explicitly:

```ts
// lib/artifacts/store.ts:293
// A removed/suspended issuer cannot leave an anonymous back door into a tenant.
return and(eq(artifacts.id, share.artifactId), await artifactAccess(share.createdBy))
```

So the policy is decided; captures simply never got it. Today, if a person is removed from a workspace or suspended, the capture links they created keep working forever.

## Current state

`lib/captures/store.ts:508-518`:
```ts
/** The capture a live share token opens. */
export async function sharedCapture(token: string) {
  if (!token.startsWith(SHARE_PREFIX)) return null
  const [row] = await db.select(getTableColumns(runCaptures)).from(runCaptureShares)
    .innerJoin(runCaptures, eq(runCaptures.id, runCaptureShares.captureId))
    .where(and(eq(runCaptureShares.tokenHash, hashToken(token)), isNull(runCaptureShares.revokedAt), eq(runCaptures.status, 'ready'))).limit(1)
  if (!row) return null
  const bytes = await fileOf(row)
  return bytes ? { ...captureView(row), bytes } : null
}
```

`runCaptureShares.createdBy` is written at `lib/captures/store.ts:497` but never read for authorization.

**Critical constraint — ownership is per-user, not per-workspace.** `lib/captures/store.db.test.ts:12-13` states the model:

> Run captures belong to one run and its owner: teammates, other devices and other workspaces never read, share or make them.

And `runCaptures` (`lib/db/schema.ts:1146-1147`) has **no `workspaceId` column** — only `userId`. So the check must be "the issuer is still an active member of at least one workspace and still owns this capture", not a workspace comparison.

**Second critical constraint — one statement.** `lib/captures/store.db.test.ts:447` and `:476` assert:

```ts
assert.equal(linked.statements, 1, 'share authority and ready media must be read in one statement')
```

Any fix that adds a second query will fail those tests. The membership check must be folded into the same `select`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Capture DB suite | `node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/captures/store.db.test.ts` | all pass (needs PG17 `*_e2e`; skip locally if absent) |
| Capture video evidence | `node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/captures/video-evidence.db.test.ts` | all pass |
| Capture units | `node --import ./tests/support/server-only.mjs --import tsx --test lib/captures/captures.test.ts` | all pass |

DB suites need `E2E_DATABASE_URL`/`MIKKA_DATABASE_URL`/`DATABASE_URL` pointing at an isolated PG17 target; they self-skip otherwise. CI runs them.

## Scope

**In scope**:
- `lib/captures/store.ts` — `sharedCapture` only
- `lib/captures/store.db.test.ts` — add the regression case

**Out of scope**:
- `createCaptureShare` / `revokeCaptureShares` — creation and revocation already check ownership correctly.
- `lib/artifacts/**` — it is already correct; do not refactor it into a shared helper in this plan (a shared helper is a good follow-up, not a prerequisite).
- `runCaptures` schema — do **not** add a `workspaceId` column here.

## Steps

### Step 1: Write the failing test first

In `lib/captures/store.db.test.ts`, immediately after the existing share assertions (around line 484, after `assert.equal(await store.sharedCapture(\`mks_${share!.token.slice(4)}\`), null)`), add:

```ts
    // A link outlives the issuer's membership no longer: revoke on removal.
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, alice])
    try { assert.equal(await store.sharedCapture(share!.token), null, 'a removed issuer cannot leave an open back door') }
    finally {
      await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,'Alice','alice@example.invalid','admin','active') ON CONFLICT DO NOTHING`, [workspaceId, alice])
    }
    assert.ok(await store.sharedCapture(share!.token), 'the link works again once the issuer is a member again')
```

**Verify**: run the suite — the new assertion fails with `actual: {...}` instead of `null`. If it passes before the fix, STOP: the test is not exercising the gap.

> **Note**: check the exact table name and column quoting used elsewhere in this file before writing the SQL. `lib/db/workspace-schema.ts:16` defines `mikka_workspace_members` with camelCase column names (`workspaceId`, `userId`), which is why they need double quotes.

### Step 2: Fold the membership check into the existing statement

Replace `sharedCapture` with:

```ts
/** The capture a live share token opens. */
export async function sharedCapture(token: string) {
  if (!token.startsWith(SHARE_PREFIX)) return null
  const [row] = await db.select(getTableColumns(runCaptures)).from(runCaptureShares)
    .innerJoin(runCaptures, eq(runCaptures.id, runCaptureShares.captureId))
    .where(and(
      eq(runCaptureShares.tokenHash, hashToken(token)),
      isNull(runCaptureShares.revokedAt),
      eq(runCaptures.status, 'ready'),
      // A removed or suspended issuer cannot leave an anonymous back door: the
      // same rule artifacts apply (lib/artifacts/store.ts). Captures are owned by
      // the person, so membership is checked on the capture's owner.
      sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.userId} = ${runCaptures.userId} and ${workspaceMembers.status} = 'active')`,
    )).limit(1)
  if (!row) return null
  const bytes = await fileOf(row)
  return bytes ? { ...captureView(row), bytes } : null
}
```

Add the import at the top of the file:

```ts
import { workspaceMembers } from '@/lib/db/workspace-schema'
```

(Check how the file already imports schema tables — it may use `@/lib/db/schema` for `runCaptures` and need a second import for the workspace table.)

**Verify**: `grep -c "workspaceMembers" lib/captures/store.ts` → at least 2 (import + usage).

### Step 3: Run the capture suites

```sh
node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/captures/store.db.test.ts
node --test-force-exit --import ./scripts/server-test.mjs --import tsx --test lib/captures/video-evidence.db.test.ts
```

**Verify**: both pass, including the two `statements === 1` assertions at `store.db.test.ts:447` and `:476`, and the new removal assertion.

### Step 4: Run the non-DB capture units

```sh
node --import ./tests/support/server-only.mjs --import tsx --test lib/captures/captures.test.ts
```

**Verify**: all pass.

## Test plan

- **New**: removal-of-issuer → 404 (added in Step 1), plus the re-add → works again case.
- **Existing pattern to follow**: the artifact equivalent, if one exists in `lib/artifacts/store.db.test.ts` — search for `sharedArtifact` there and match its structure.
- **Must not regress**: `store.db.test.ts:447` and `:476` (`statements === 1`).

## Done criteria

- [ ] New test fails before Step 2 and passes after
- [ ] `lib/captures/store.db.test.ts` passes, including both `statements === 1` assertions
- [ ] `lib/captures/video-evidence.db.test.ts` passes
- [ ] `lib/captures/captures.test.ts` passes
- [ ] `git status` shows only `lib/captures/store.ts` and `lib/captures/store.db.test.ts` modified
- [ ] No `workspaceId` column added to `runCaptures`

## STOP conditions

Stop and report if:
- The new test passes before Step 2 (it is not exercising the gap).
- Folding the membership check into the select breaks the `statements === 1` assertions (means the join produced a second statement; report rather than loosening the assertion).
- `runCaptures` turns out to have a `workspaceId` column at HEAD (the ownership model changed; the check should then be a workspace comparison).
- A suspended user (`status='suspended'`) is expected by some other test to still read captures.

## Maintenance notes

- The rule now lives in two places (`lib/captures/store.ts` and `lib/artifacts/store.ts`). If a third share type appears, extract the "issuer still active" predicate into one helper — but not in this PR.
- A reviewer should confirm the check uses `runCaptures.userId` (the capture owner), not `runCaptureShares.createdBy`. They are equal today because only the owner can create a share, but the owner is the right subject: if sharing is ever delegated, the capture's owner is still the tenant.
- Follow-up, not this plan: `revokeCaptureShares` is never called on account deletion — check `lib/account/delete.ts` in a separate issue.
