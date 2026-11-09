# Diagnostic prepare / cleanup through the existing trusted carrier

Status: offline, unbound, disabled. This directory creates no commit or ref and does not call GitHub, Infisical, Vercel, SMOKE, a database, E2B, or a model. Neither workflow is an active `.yml`: both remain `.yml.in` with `if: false`.

## Finding and minimal change

The frozen prepare v2 workflow uses `ops/1505-diagnostic-prepare-r7-20261109`; the frozen cleanup workflow uses `ops/1505-diagnostic-cleanup-r7-20261109`. Neither has an actual trust receipt for that new branch in the supplied evidence. Both also require a single APP parent, which would not make the new operator a normal fast-forward descendant of the existing carrier.

These two independent drafts instead use the root-designated, previously successful branch `ops/1505-smoke-github-readonly-20261109`, with exactly two ordered parents `[A, C]`: `A` is the fresh reviewed APP commit; `C` is the independently verified, closed head of that carrier immediately before this operation. The tree is built from **A**, never copied or merged wholesale from C. The prepare tree must differ from A by exactly the original three added paths, mode `100644`; cleanup must differ by exactly its original two added paths, mode `100644`. Existing checks enforce those deltas and reject any carried-over active workflow, changed product file, deletion, or wrong mode.

Only workflow branch selection, a separate unfilled carrier-parent binding, and the ordered-parent checks changed. See `diffs/prepare.diff` and `diffs/cleanup.diff`. The original 13 prepare pins remain byte-for-byte unchanged and null. `HELPER_PARENT` continues to mean A; it is not repurposed as C. The new structural binding is supplied separately as `CLOSED_CARRIER_PARENT`, from that operation's `carrier.unfilled.json`. Cleanup's original bindings JSON is also unchanged. The prepare and cleanup carrier bindings are separate because cleanup may run after intervening normal closure commits; it must not silently reuse prepare's old C.

## Preserved contracts

- Prepare helper `.mjs.in` is copied byte-for-byte from the frozen v2 package; original Bot receipt is unchanged. The v2 materializer's embedded workflow and README were checked against the frozen files without running its helper CLI. Its six configurable constants and already reviewed application-version equality check are unchanged.
- Cleanup helper is the complete original `5958dea38437de20512bbbdf60b940ccc83f00ff:scripts/ops/issue1505-diagnostic-window.mjs`, 27,063 bytes, SHA256 `46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c`, blob `e9f07af8ec87eb83b3eb46c046731390ba97c1d9`. No helper function or old CLI guard changed. Workflows import pure exports; they never execute `main`, `renewWindow`, or the old CLI's one-parent path.
- Prepare still performs the original exact seven successful R7 job checks, fresh APP/main/version checks, normal SMOKE authentication/team/idle checks, and one `prepareWindow` call. No new scope is created by this package.
- Both original queues remain: workflow `production-smoke-owner-acceptance`, job `web-deploy-production`, `cancel-in-progress: false`, `queue: max`. GO values, attempt 1, APP, main checks, all original clock limits, the entry + 10 minute budget, and 10 minute job limit are unchanged. Queue delay cannot extend a window.
- The OIDC action, identity `2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`, audience, project, `prod` environment, secret paths, permissions, and steps are byte-for-byte unchanged. Prepare retains only its original SMOKE email/password and `/platform` VERCEL_TEAM_TOKEN reads. Cleanup retains only `/platform` VERCEL_TEAM_TOKEN; it has no SMOKE/DB/E2B/provider secret or login.
- Cleanup rechecks source, exact helper, main and time before OIDC, after OIDC, and before DELETE. The original exact ID/value digest checks, unknown DELETE checkpoint, ID 404 plus key absence proof, and actual report retention are unchanged. It deletes project configuration; it does not retract an existing deployment.

## Root's future binding / normal FF sequence

1. Wait for the real R7 contract to be satisfied. Independently obtain A/tree and all original release/APP pins. No old run, old APP, or local worker calculation is substituted for those facts.
2. Read the carrier's actual current head C and its closure evidence. Verify it is inactive, with no competing owner or live operation. Review all workflows reachable in the **prospective A-based tree** for triggers on the carrier branch. This preparation does not assert that a future carrier head is already closed, that it is available, or that a future OIDC request has succeeded.
3. Fill the original 13 prepare pins and this operation's `carrier.unfilled.json`; map `closedCarrierCommit` to `__CLOSED_CARRIER_PARENT__`. Fill branch pin `__BRANCH__` with the trusted carrier branch. Bind the helper exactly through the existing six-placeholder contract, recalculate its hash, and retain the original GO. APP, times and C are deliberately unfilled here.
4. Build the reviewed operator tree from A plus exactly the three allowed prepare paths. Create a normal merge commit with ordered parents `[A, C]`, verify tree/diff/modes/blob hashes/parents, then perform only the root-reviewed expected-head normal FF from C. The presence of C as a direct parent allows ancestry-preserving FF; it does not authorize overwriting an unexpected current ref. No force update or carrier-tree content inheritance is needed.
5. Activate only through the separately reviewed enable/binding diff. Observe the actual run and preserve its scope receipt. Close the carrier by a normal successor after the operation, following the existing ownership protocol. No closure is performed here.
6. If cleanup is needed, use its independent fresh A/C bindings and original precise scope receipt. Repeat the same tree-from-A / ordered parents / expected-head FF process, with exactly two added cleanup paths and the original cleanup GO. Do not reuse a stale prepare C or confuse cleanup APP identity with scope-creation provenance.

The old v2 materializer remains frozen and still emits its old single-parent draft. Use this separate adapter for the trusted-carrier candidate, not the old v2 output alone. The adapter reads and verifies frozen local files; it does not bind values or activate anything.

## Cleanup provenance limit

The original helper exports historical SOURCE `e33e3a91d4011efbe768b11b428a5d152ede744a` and TREE `b2e36d3351654fceec59fe138a55de31cb155df9`. For imported `removeOwnedWindow`, those are schema pins for the target object; they are not a new scope-creation receipt and are not the new operator's APP identity. The caller must use the actual fresh ID, value SHA256 and expiry from root-reviewed creation evidence. `freshScopeReceiptSha256` is a root-reviewed provenance anchor: the workflow does **not** download or independently hash that receipt artifact.

## Verification scope

Only offline syntax, exact inverse/conservation checks, and relevant branch/ordered-parent guard checks are run. Guard checks execute extracted synchronous source fragments with explicit in-memory Git/environment responses; no subprocess Git, HTTP, OIDC or pure helper business function runs. They do not prove cloud trust, idle state, a real source tree, scope creation/deletion, or performance. Original frozen directories and the v2 materializer are hashed before and after. See `validation/` and the final manifest for actual results.

There are zero new formal samples and no new release claim. All APP/time/carrier/scope bindings remain unfilled.
