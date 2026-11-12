# Mikka UX quality and action-coverage audit

Owner: [#2212](https://github.com/alexj11324/Mikka/issues/2212). Related #1646, #1979, #1980 and #1966 retain their own defect, CI and production owners. This is a source-bound **first pass**, not a completed whole-product browser audit.

## Quality vocabulary and evidence

| Classification | Meaning | Minimum proof |
| --- | --- | --- |
| Missing affordance | Promised authorized operation has no discoverable completion path | Command + role + expected entry + real reachable route check |
| Dead/inert control | Visible actionable control cannot perform its claimed action | Live click + no effect or denied/incorrect call |
| Misleading feedback | Success/loading UI does not match server/persisted fact | HTTP/error + fresh authorized readback |
| Action parity gap | Same promised job behaves differently in entry variants | Equivalent role/command across two live entrances |
| State-model drift | Task/Run/Factory facts are interpreted inconsistently | Canonical DTO vs actual rendered facts; do not equate derived with writable |
| Recovery / accessibility defect | Failure, keyboard, touch, responsive or navigation blocks task | Reproduction with fixed version and input state |
| Source-only candidate | Plausible failure from code; not runtime-proven | Exact file:line and reason; next falsifying test |
| Verified intentional | Different UI / unavailable operation allowed by ACL or design | Rule/owner/permission + usable alternative path |

For one result use:
`entity | user job | command and canonical writer | initial state / target | role/ACL | promised routes | actual control/handler | server ACK | persisted readback | failure/retry | source public/hosted SHA | runtime/platform | screenshot/log | severity/likelihood/impact | owner / issue | classification`.

An audit must enumerate rows and explicit `not-tested` scope; claiming 100% coverage requires a defined denominator (all promised jobs × authorized roles × applicable entry classes) and independently observed outcomes. A static AST pass and a rendered menu count are not that denominator.

## First source-only sweep (2026-11-12, public main `b220d70f2b8ee762fb633eb65f85b86c01c496ce`)

### Confirmed *coverage* gaps, not yet product bugs

1. **Action AST scope:** `scripts/lint-ui.mjs` builds `files` with `apps/`, `packages/` and `scripts/` excluded; `interactionFiles` filters public JSX sources and excludes UI/ReUI primitives. Therefore this particular `auditInteractions` run does not assert direct coverage of all `apps/mobile`, `apps/desktop`, private hosted `slots/`, or native mounted actions. Existing other tests and native suites may cover portions; their actual proof must be mapped rather than assumed absent.
2. **Static handler success is weaker than behavior:** `scripts/interaction-policy.mjs` correctly rejects many empty callbacks, bare Toast/Alert and placeholder links. For a call not recognized as inert, `meaningful` can accept a call expression without validating the remote response or durable state; this rule does not prove API/PG success, failure recovery or visual click reachability.
3. **No complete action-reachability contract:** `scripts/entity-ui-policy.mjs` declares canonical entities/components and `docs/review-checklist.md` says shipped capability must be reachable. Neither by itself enumerates every authorized business command against promised entry points, transitions and persisted outcomes. Action coverage needs a role-aware forward and reverse matrix, not more generic button selectors.
4. **UI/UX Pro Max skill setup mismatch:** the previous vendored `ui-ux-pro-max/SKILL.md` advertised a `scripts/search.py` command although scripts/data were intentionally omitted; the new adapted skill removes the broken invocation and retains reference-based guidance.

### Important negative control: do not file a false missing-Status defect

`lib/issue-meta.ts` defines writable Task statuses `backlog/todo/doing/review/done/canceled/duplicate`, whereas `lib/task-state.ts` derives `waiting/blocked/failed/running/queued` from Task/Run/Factory. `components/workspace/task-detail-frame.tsx` already constructs a Task business-status menu with `onSelect -> onStatus`; `components/workspace/task-detail.tsx` owns `onStatus -> saveIssue`, and the hosted `slots/task-detail.tsx` renders the `row.menu` as a dropdown. This is **source evidence of a full-detail affordance**, not proof that every entry or role can operate it. Test the real official detail, compact Coordinator, Board, Search and mobile navigation; do not demand a manual button setting derived `running`.

### Targeted next checks

- Task and Project: business status/priority/assignee/delegate, dispatch/start/stop/retry and historic vs current run, child relations, team scope, 0-run and Factory; verify actual UI route+ACL. Owner: existing #1974/#1975/#1978/#1979 where applicable.
- Chat/Inbox: selected answer, actual send pending, delayed ACK, 401/409/503, draft preservation, read/reopen and timer expiry; owners #2120/#1820 where applicable.
- Settings/Connections/Plugins/Devices: connect/revoke/delete, selection/discoverability, disabled explanation, secret isolation, cross-client readback; owner #1979.
- Files/Artifact/Review: link/file identities, permissions, preview/download bytes, actions under partial failures; owner #1966/#1732.
- UX cross-cutting: keyboard/IME, click target, narrow right panel wrap, long Chinese strings, history/deep links, empty/loading/error, focus and screen-reader semantics. Use local production renderer/isolated accounts; source hypotheses remain unverified without real actions.

## Release and CI boundaries

Use the Mikka-specific [UX audit skill](../../.claude/skills/mikka-ux-quality-audit/SKILL.md). Keep existing Nx affected tests, `pnpm lint:ui`, static policy and DB/API unit ownership; add targeted falsifiable tests when a real gap is reproduced. No new polling, general browser E2E PR gate, unsanctioned production writes, second UI or paid component restyling. Report the exact current public/private tested revisions and leave unobserved mobile/production states explicitly open.
