## Problem

The normal New task form disables Default and enabled custom Profiles when the read-only management projection returns `checking`. That projection intentionally does not probe allowance; reopening the picker repeats the same read. A pending check therefore prevents the Owner from requesting the authoritative dispatch check. The production observation involved all three Owner Profiles and Default, with no task submitted from the disabled picker.

## Change

Allow `checking` selections for a present, enabled, non-archived Profile and for Default. Show the existing checking message as a neutral pending status. Reuse one predicate in the picker and submit guard. Confirmed unavailable states, missing reads, disabled roles and archived roles remain blocked, including when a stale projection says available. The form still sends only the structured Profile reference. Server authorization, quota probing, source binding and first claim are unchanged.

## Validation

- Pre-change reproduction: 5 tests, 3 pass and 2 expected failures for the disabled checking option and blocking notice.
- Final `CI=true pnpm test:subscription-usability`: 137/137, 0 failures, 0 skips, including six new React/Select-contract cases.
- Full typecheck, UI lint, four-file oxlint and diff check pass. The Select mock is an explicit noninteractive property projection; this suite does not claim real popup pointer/keyboard behavior or screenshots.
- These commands ran on the final six-file patch based on 9cc753c660f31a95598998c43545ea030240e9e2, then captured unchanged as checkpoint ab83ac016b7ea65843cc376af8431ecb976a5fb6, tree 1cd1b7566b4da99dc9ae2b241909b9820e5f6524.
- One production build, normal authenticated HTTP and actual picker screenshots will run against the final merged batch. No database, provider, model or DeepSeek API calls were made for this patch.

## Boundaries and risk

The observed UI blocker is reproducible whenever an otherwise selectable role has stale or absent allowance. Its impact is preventing an explicit Owner choice. The change permits a request for a check; it does not permit execution. It does not establish or repair the unknown historical ALEX66 claim cause or guarantee a successful ALEX67 Decision.
