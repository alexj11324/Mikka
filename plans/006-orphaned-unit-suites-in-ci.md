# Plan 006: Run the six orphaned unit suites in CI

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result. On any STOP condition, stop and report.
>
> **Drift check (run first)**: `git diff --stat 89f5e7634..HEAD -- scripts/ci/tasks.json package.json`
> On a mismatch with the excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `89f5e7634`, 2026-11-19

## Why this matters

Six `test:*` scripts exist in `package.json`, are correct, and **are never executed by anything**. I verified this three ways: no other script calls them, they are absent from `scripts/ci/tasks.json`, and they are absent from `pnpm check`'s 86 segments and from every `.github/workflows/*.yml`.

They cover 21 test files:

| Script | Files | What is unprotected today |
|---|---|---|
| `test:coding-workspace-review-runtime` | 8 | terminal runtime/wire/http, preview runtime/route, machine metrics/sessions, cloudflare review |
| `test:drive` | 5 | Drive contract, ULID, HTTP, store, client |
| `test:github-pulls` | 4 | GitHub PR directory |
| `test:model-gateway-litellm` | 1 | LiteLLM gateway config |
| `test:factory-query-http` | 1 | Factory HTTP reads |
| `test:factory-monitor-http` | 1 | Factory monitor HTTP |

I ran a sample (`lib/factory/query-http.test.ts`, `lib/github/pulls.test.ts`, `lib/onboarding-steps.test.ts`) — **7 passed, 0 failed**. The tests are healthy; only the wiring is missing. That means a regression in the terminal runtime or Drive storage today produces green CI.

## Current state

`scripts/ci/tasks.json` is an object keyed `core-N` / `integration-N`, each:
```json
  "core-2": {
    "command": "pnpm test:factory-check-independence",
    "kind": "core",
    "env": {}
  },
```

`scripts/ci/graph.mjs:96` builds the dependency edges automatically:
```js
for (const [key, value] of Object.entries(tasks)) addTask(taskId(key), value.command, value.kind, [])
```
and `addTask` → `commandFiles(command)` extracts the test-file paths out of the command string, so a new entry with a real command is picked up by Nx selection with **no other change**. That is the whole fix.

`scripts/ci/select.mjs:51` then selects a task when `selected.has(taskId(key))` — i.e. when a changed file reverse-depends on it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Confirm the suites run | `pnpm test:drive` etc. | all pass |
| CI selection (no network) | `CI_BASE=origin/main CI_HEAD=HEAD node scripts/ci/select.mjs` | JSON with `unit_tasks` |
| Policy tests | `node --test scripts/interaction-policy.test.mjs` | pass |

## Scope

**In scope**:
- `scripts/ci/tasks.json` — add six entries
- `package.json` — **only if** a script needs fixing to run (it should not)

**Out of scope**:
- `scripts/ci/select.mjs`, `scripts/ci/graph.mjs` — the machinery is correct; the gap is the missing data.
- `pnpm check` — see plan 007's note; do not add these there in this plan.
- Any test file — they already pass.

## Steps

### Step 1: Confirm each suite runs standalone

```sh
for s in test:coding-workspace-review-runtime test:drive test:github-pulls test:model-gateway-litellm test:factory-query-http test:factory-monitor-http; do
  echo "=== $s"; pnpm $s > /tmp/$s.log 2>&1; echo "exit=$?"; tail -3 /tmp/$s.log
done
```

**Verify**: every `exit=0`. If any fails, STOP — a broken suite is a separate finding, and wiring it in would turn CI red for an unrelated reason.

### Step 2: Add the six entries to `scripts/ci/tasks.json`

Find the highest existing `core-N` key (`node -e "const t=require('./scripts/ci/tasks.json');console.log(Object.keys(t).filter(k=>k.startsWith('core-')).map(k=>+k.slice(5)).sort((a,b)=>b-a)[0])"`), then append six entries continuing the sequence. Keep the existing formatting (two-space indent, `kind: "core"`, `env: {}`):

```json
  "core-NN": {
    "command": "pnpm test:coding-workspace-review-runtime",
    "kind": "core",
    "env": {}
  },
```
…and so on for the other five.

Use `kind: "core"` for all six: none of them needs a database, and `core` is the kind used for plain unit suites (`core-2` is `test:factory-check-independence`).

**Verify**: `node -e "const t=require('./scripts/ci/tasks.json');const cmds=Object.values(t).map(v=>v.command);['test:coding-workspace-review-runtime','test:drive','test:github-pulls','test:model-gateway-litellm','test:factory-query-http','test:factory-monitor-http'].forEach(s=>console.log(s, cmds.some(c=>c.includes(s))))"` → six `true`.

### Step 3: Prove the selection now maps changed files to the new tasks

```sh
node -e "
const {buildGraph}=await import('./scripts/ci/graph.mjs');
" 2>/dev/null || true
CI_BASE=origin/main CI_HEAD=HEAD node scripts/ci/select.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('units:',j.units.length);console.log(j.unit_tasks.filter(t=>/drive|pulls|litellm|query-http|monitor-http|review-runtime/.test(t.command)).map(t=>t.command))})"
```

Then simulate a change to a covered file:

```sh
git stash list > /dev/null
node -e "
const {select}=await import('./scripts/ci/select.mjs');
const {buildGraph}=await import('./scripts/ci/graph.mjs');
const plan=await buildGraph();
const r=await select(plan,[{file:'lib/drive/ulid.ts',status:'M',mode:'100644',oldMode:'100644'}]);
console.log(r.unit_tasks.map(t=>t.command).filter(c=>c.includes('test:drive')));
" --input-type=module
```

**Verify**: prints `[ 'pnpm test:drive' ]`. (If `origin/main` is unavailable locally, use `CI_BASE=$(git rev-parse HEAD~1)`.)

### Step 4: Run the CI-selection tests

```sh
node --test scripts/ci/*.test.mjs
```

**Verify**: all pass. If a test asserts the exact task count or the exact key list, update it to the new count — that is a legitimate expectation change, not a test to weaken.

## Test plan

- The change **is** the test wiring. The assertion is Step 3: a changed `lib/drive/**` file selects `pnpm test:drive`.
- If `scripts/ci/*.test.mjs` has a fixture listing all task keys, extend it with the six new keys.

## Done criteria

- [ ] All six suites pass standalone
- [ ] `scripts/ci/tasks.json` contains all six commands
- [ ] Selecting a change to `lib/drive/ulid.ts` yields `pnpm test:drive`
- [ ] `node --test scripts/ci/*.test.mjs` passes
- [ ] `git status` shows only `scripts/ci/tasks.json` (plus a test fixture if one lists keys)

## STOP conditions

Stop and report if:
- Any suite fails standalone (report which and why; do not wire a red suite).
- `graph.mjs`'s `commandFiles` cannot parse one of the commands (they use `--import` and `--test`; check that `lib/drive/ulid.test.ts` appears in the parsed set).
- Adding the entries makes `node scripts/ci/select.mjs` report `full: true` for an unrelated change (means a command string contains a token that looks like a global path).

## Maintenance notes

- This closes the "tests exist but nothing runs them" gap for these six. The same audit should be repeated for DB suites: `scripts/run-db-tests.mjs` has a `REQUIRED_SUITES` inventory, but nothing enforces that every `*.db.test.ts` appears in it.
- A reviewer should confirm the six commands are byte-identical to `package.json`'s scripts (a typo here silently skips the suite).
- Follow-up: add a policy test that fails when a `test:*` script in `package.json` is referenced by neither `tasks.json` nor `check`. That is the fail-closed guard this plan does not add.
