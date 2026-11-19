# Plan 005: Give identity resolution one boundary and break the auth import cycle

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- lib/issue-access.ts lib/workspace-access.ts lib/acting-user.ts lib/team-access.ts lib/issue-team-access.ts`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt / correctness
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

Two problems share one root.

**Problem A — a runtime import cycle.** `lib/workspace-access.ts` imports `requireUser` from `lib/issue-access`; that module imports `lib/issue-team-access`; that one imports `lib/team-access`; and `lib/team-access.ts:8` imports `WorkspaceError` back from `lib/workspace-access`. This is a **value-level** cycle, not `import type`. It works today only because `WorkspaceError` is referenced inside functions after hoisting. Any top-level use (a constant, a class field, a decorator) becomes `undefined is not a constructor` at runtime. It also blocks isolating these four modules for tests.

**Problem B — identity has two conventions.** `lib/acting-user.ts` owns `currentUser()`, which correctly handles `actAs` (how MCP tools and mobile routes run actions under a non-session identity), `tokenWorkspace`, `enterprisePrincipal`, and `noteLogUser`. `lib/issue-access.ts:22` already delegates to it:

```ts
export async function requireUser() {
  const { currentUser } = await import('@/lib/acting-user')
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}
```

Meanwhile six action files each re-copy a local helper that calls `auth.api.getSession` directly, bypassing `actAs`, `tokenWorkspace` scope and `noteLogUser`. Those paths lose the acting identity and the request-log attribution.

Moving `requireUser` into `lib/acting-user.ts` fixes both: the cycle disappears (nothing in the auth chain needs `issue-access` any more), and the six files have an obvious correct import.

## Current state

The cycle, exactly:
- `lib/workspace-access.ts:9` — `import { requireUser } from '@/lib/issue-access'`
- `lib/issue-access.ts:8` — `import { issueTeamAccess } from '@/lib/issue-team-access'`
- `lib/issue-team-access.ts:7` — `import { accessibleTeamScopes } from '@/lib/team-access'`
- `lib/team-access.ts:8` — `import { WorkspaceError, type WorkspaceTransaction } from '@/lib/workspace-access'`

`lib/acting-user.ts` already imports `getSession` from `lib/session`, `noteLogUser`, and the principal symbols. It does **not** import `lib/issue-access`, so it is a safe home.

The six duplicate helpers (verify each still exists before editing):
- `app/actions/captures.ts:12`
- `app/actions/preferences.ts:17`
- `app/actions/agents.ts:59`
- `app/actions/coordinator.ts:55`
- `app/actions/settings-activity.ts:21`
- `app/actions/pending-actions.ts:10`

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Confirm the cycle | `node -e "…"` (Step 1 script) | lists the four modules |
| Auth-adjacent units | `node --import tsx --test lib/api-auth.test.ts lib/daemon-authorization.test.ts` | all pass |
| Settings backend | `pnpm test:settings-backend` | all pass |
| Actions that changed | `pnpm test:chat-actions` / `pnpm test:issues` (pick by file) | all pass |

Typecheck runs in CI only — do not run it on a Mac.

## Scope

**In scope**:
- `lib/acting-user.ts` — receive `requireUser`
- `lib/issue-access.ts` — re-export for compatibility
- `lib/workspace-access.ts` — import from the new home
- The six action files — delete the local helper, import the shared one

**Out of scope**:
- The other 150 `auth.api.getSession` call sites. Converting them all is a separate, larger change. This plan fixes the six that *already* have a duplicated helper, because those are unambiguously drift.
- `lib/api-auth.ts` — its `getApiSession` is a different entry (PAT + cookie), not a duplicate of `currentUser`.
- Any change to authorization semantics.

## Steps

### Step 1: Prove the cycle exists (record it)

```sh
node -e "
const fs=require('fs');
const edges={
 'lib/workspace-access.ts':['lib/issue-access.ts'],
 'lib/issue-access.ts':['lib/issue-team-access.ts'],
 'lib/issue-team-access.ts':['lib/team-access.ts'],
 'lib/team-access.ts':['lib/workspace-access.ts'],
};
for(const [f,deps] of Object.entries(edges)) for(const d of deps){
  const src=fs.readFileSync(f,'utf8');
  const name=d.split('/').pop().replace('.ts','');
  const re=new RegExp('from [\\'\"]\\\\./'+name+'[\\'\"]');
  console.log(f,'->',d, re.test(src)?'VALUE import':'MISSING');
}"
```

**Verify**: prints four lines, all `VALUE import`.

### Step 2: Move `requireUser` into `lib/acting-user.ts`

Cut the function from `lib/issue-access.ts:22-28` and paste it into `lib/acting-user.ts`, below `currentUser()`. It needs `ActionFailureError` from `@/lib/action-error` — add that import.

```ts
/** The acting user, or `authRequired`. The one entry every server action and
 * route should use: it honours `actAs`, the token's workspace scope and
 * request-log attribution. */
export async function requireUser() {
  const user = await currentUser()
  if (!user) throw new ActionFailureError('authRequired')
  return user
}
```

In `lib/issue-access.ts`, replace the removed function with a re-export so the ~40 existing importers keep working:

```ts
export { requireUser } from '@/lib/acting-user'
```

**Verify**: `grep -n "export { requireUser }" lib/issue-access.ts` → one hit, and `grep -c "export async function requireUser" lib/issue-access.ts` → 0.

### Step 3: Point `workspace-access` at the new home

`lib/workspace-access.ts:9`: change
```ts
import { requireUser } from '@/lib/issue-access'
```
to
```ts
import { requireUser } from '@/lib/acting-user'
```

**Verify**: re-run the Step 1 script — the `lib/workspace-access.ts -> lib/issue-access.ts` edge is gone, and the remaining three edges no longer close a loop through `workspace-access`.

### Step 4: Delete the six duplicate helpers

For each of the six files, find the local `async function requireUser()` (or similarly named local helper) and replace it with:
```ts
import { requireUser } from '@/lib/acting-user'
```

Do them one at a time and run that file's test after each:
```sh
node --import tsx --test <the matching test file>
```

**Verify**: `grep -rn "auth.api.getSession" app/actions/captures.ts app/actions/preferences.ts app/actions/agents.ts app/actions/coordinator.ts app/actions/settings-activity.ts app/actions/pending-actions.ts` → 0 hits.

### Step 5: Run the auth-adjacent suites

```sh
node --import tsx --test lib/api-auth.test.ts lib/daemon-authorization.test.ts
pnpm test:settings-backend
```

**Verify**: all pass.

## Test plan

- No new test file. The regression is structural: `node --import tsx --test lib/api-auth.test.ts` plus the per-action suites prove the wiring.
- Add one assertion to the `actAs` coverage if it exists — search `grep -rln "actAs(" lib/*.test.ts app/**/*.test.ts`. If a test already proves an MCP tool can act through an action, extend it to one of the six converted files. If none exists, record in the PR that `actAs` coverage is unchanged, rather than inventing a harness.

## Done criteria

- [ ] `requireUser` is defined in `lib/acting-user.ts` and re-exported from `lib/issue-access.ts`
- [ ] `lib/workspace-access.ts` imports it from `lib/acting-user`
- [ ] The four-module cycle no longer closes (Step 1 script shows no loop)
- [ ] The six action files have no `auth.api.getSession` and no local `requireUser`
- [ ] `lib/api-auth.test.ts`, `lib/daemon-authorization.test.ts`, `pnpm test:settings-backend` pass
- [ ] No authorization semantics changed (a reviewer should confirm no `requireWorkspace`/role check was dropped)

## STOP conditions

Stop and report if:
- Any of the six files uses `auth.api.getSession` for something other than "get the current user" (e.g. reading `session.session.id` for a fresh-session check). Those need `currentUser`'s sibling, not `requireUser`.
- `lib/issue-access.ts` re-export causes a new cycle (check with the Step 1 script after Step 3).
- A test asserts that one of the six actions throws `authRequired` for an `actAs` caller (that would mean the old behaviour was deliberate).
- Moving `requireUser` changes a type: `requireUser`'s return type comes from `currentUser`, which includes the principal symbols. If a caller destructures in a way that breaks, report the caller.

## Maintenance notes

- This is a pure move plus six deletions. A reviewer should be able to read the diff in one pass.
- The other ~150 `auth.api.getSession` sites remain. They are not drift in the same sense — many legitimately need the raw session (device auth, token exchange). A follow-up issue should classify them rather than bulk-convert.
- If someone later adds a seventh action file with a local session helper, `pnpm lint:ui` will not catch it. Consider a policy test in a follow-up.
