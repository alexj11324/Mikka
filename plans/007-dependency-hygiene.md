# Plan 007: Remove three unused dependencies and pin six floating versions

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- package.json pnpm-lock.yaml`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but land after plan 001, which also touches `package.json`, to keep each diff readable)
- **Category**: dependency hygiene
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

Two separate hygiene problems in one manifest.

**Three declared dependencies are never imported.** A whole-repo search across `lib/ app/ components/ packages/ apps/ scripts/ services/ cloudflare/ tests/` for `from '<pkg>'`, `require('<pkg>')` and `import('<pkg>')` returns **0 hits** for all three. Every install and image build carries them, and `unstorage` is a beta sitting in the lockfile.

**Six dependencies float on `"latest"`.** The same manifest exact-pins `undici`, `date-fns`, `happy-dom` and others, and `pnpm-workspace.yaml` carries comments about release-age discipline — so a locking convention exists and these six escaped it. `@base-ui/react` is the entire UI substrate; a bare `pnpm update` can cross a major with zero code change.

## Current state

Unused (`package.json`):
```
348:    "file-type": "^22.3.0",
389:    "unstorage": "2.0.0-beta.0",
391:    "vaul": "^1.1.2",
```

Floating on `latest`:
```
263:    "@base-ui/react": "latest",
333:    "class-variance-authority": "latest",
336:    "cn": "latest",
355:    "lucide-react": "latest",
363:    "next-themes": "latest",
379:    "shadcn": "latest",
387:    "tw-animate-css": "latest",
```

Lockfile-resolved versions (read from `pnpm-lock.yaml` at this commit — use these exact strings):
- `@base-ui/react` → `1.9.0`
- `class-variance-authority` → `0.7.1`
- `cn` → `0.2.6`
- `lucide-react` → `0.562.0`
- `next-themes` → `0.4.6`
- `shadcn` → `4.22.1`
- `tw-animate-css` → `1.4.0`

Note on `cn`: the npm package `cn@0.2.6` duplicates the repo's own `cn` from `lib/utils.ts` (clsx + tailwind-merge). Only three business components import the npm one — `components/chat/unread-pill.tsx:10`, `components/workspace/task-state-icon.tsx:10`, `components/workspace/issue-activity-feed.tsx:5` — while `@/lib/utils` has ~93 importers. `components/ui/why-disabled.tsx:4` also imports `cn`, but that file is a **protected component library root** (`ui-policy.json` `componentRoots`) — leave it alone and keep the dependency if that file still needs it.

> **Important**: because `components/ui/why-disabled.tsx` imports `cn`, removing the npm `cn` package would break a protected file. So for this plan: **repoint the three business imports and keep `cn` in the manifest**, then record the removal as a follow-up that needs the protected-library owner. Do not delete `cn`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| UI policy | `node scripts/lint-ui.mjs` | `0 errors` |
| i18n | `node scripts/check-i18n.mjs` | `i18n check passed` |
| Repointed component tests | `node --import tsx --test components/workspace/task-state-icon.test.ts` | pass |

## Scope

**In scope**:
- `package.json` — delete 3 lines, replace 7 `"latest"` values
- `pnpm-lock.yaml` — regenerated
- `components/chat/unread-pill.tsx`, `components/workspace/task-state-icon.tsx`, `components/workspace/issue-activity-feed.tsx` — change the `cn` import source

**Out of scope**:
- `components/ui/why-disabled.tsx` and any other file under `components/ui/`, `components/reui/`, `components/motion/`, `components/agents/`, `components/ai-elements/`, `components/blocks/` — protected library roots.
- Removing the `cn` package from the manifest (blocked on the protected file; see above).
- Any version **change** — this plan pins what is already installed, nothing more.

## Steps

### Step 1: Confirm the three are still unused

```sh
for d in file-type unstorage vaul; do
  printf "%s: " "$d"
  grep -rn "from '$d'\|from \"$d\"\|require('$d')\|require(\"$d\")\|import('$d')" \
    --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' \
    lib app components packages apps scripts services cloudflare tests 2>/dev/null | wc -l
done
```

**Verify**: `0`, `0`, `0`. If any is non-zero, STOP — the dependency is used and this plan's premise is wrong.

### Step 2: Delete the three lines

Remove from `package.json`:
```json
    "file-type": "^22.3.0",
    "unstorage": "2.0.0-beta.0",
    "vaul": "^1.1.2",
```

**Verify**: `grep -cE '"(file-type|unstorage|vaul)":' package.json` → `0`.

### Step 3: Pin the seven floating versions

Replace each `"latest"` with the lockfile-resolved version from the table above. Keep exact pins (no `^`) to match the convention already used for `undici`/`date-fns`.

**Verify**: `grep -cE '": "latest"' package.json` → `0`.

### Step 4: Repoint the three `cn` imports

In each of the three business files, change:
```ts
import { cn } from 'cn'
```
to:
```ts
import { cn } from '@/lib/utils'
```

**Verify**: `grep -rn "from 'cn'" components/chat/unread-pill.tsx components/workspace/task-state-icon.tsx components/workspace/issue-activity-feed.tsx` → 0 hits.

### Step 5: Install and confirm the lockfile only lost the three

```sh
pnpm install
```

**Verify**: `git diff --stat pnpm-lock.yaml` shows removals for the three packages and **no version changes** for the seven pinned ones (they were already resolved at those versions).

### Step 6: Run the gates

```sh
node scripts/lint-ui.mjs
node scripts/check-i18n.mjs
node --import tsx --test components/workspace/task-state-icon.test.ts
```

**Verify**: `0 errors`; `i18n check passed`; test passes.

## Test plan

No new tests. The `cn` repoint is behaviour-preserving only if `@/lib/utils`'s `cn` is tailwind-merge-aware the same way — it is (`lib/utils.ts:5`), but a reviewer should confirm the three files' class strings still merge correctly. `components/workspace/task-state-icon.test.ts` exercises the status icon classes.

## Done criteria

- [ ] `package.json` has no `file-type`, `unstorage` or `vaul`
- [ ] `package.json` has no `"latest"`
- [ ] The three business files import `cn` from `@/lib/utils`
- [ ] `pnpm install` succeeds and the lockfile diff contains no version changes
- [ ] `node scripts/lint-ui.mjs` reports 0 errors
- [ ] `node scripts/check-i18n.mjs` passes

## STOP conditions

Stop and report if:
- Any of the three packages turns out to be imported dynamically via a computed specifier (search for the package name as a plain string too: `grep -rn "unstorage" --include='*.ts' lib app`).
- `pnpm install` changes the resolved version of any of the seven pinned packages (means the lockfile was already drifted from the manifest — report the diff rather than accepting it).
- Repointing `cn` changes rendered classes in a snapshot test.

## Maintenance notes

- Pinning to the lockfile's current resolution is deliberately conservative: it makes the manifest honest without moving any code. A follow-up can upgrade deliberately, one package at a time.
- The `cn` package remains because a protected library file imports it. If that file is ever rewritten, remove the dependency then.
- A reviewer should check the lockfile diff is purely additive/removal for three packages.
