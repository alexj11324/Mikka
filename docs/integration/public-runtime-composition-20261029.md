# Public runtime integration review — 2026-10-29

Reviewed the current integration of PRs #398, #362, #363, #345 and #346, with particular attention to the claim policy, hosted CLI lifecycle, evidence capture and the existing approval ledgers. This follow-up is based on integration commit `7e765d94`.

## Corrected integration failures

1. **Dedicated Thread evidence selected the source Bot machine.** The Thread claim uses a separate device and display `:1`; the capture implementation still required the workspace Bot device. Captures now select the persisted Thread machine when one exists, bind the owner/workspace/device, and never fall back to the Bot if that Thread resource is unavailable. Recording finalization uses the same machine even after the run ends. Explicit Thread-machine end saves outstanding recordings before killing the sandbox.

2. **The CLI permission callback rejected the new evidence tools.** The existing strict registrations now include the three cloud capture tools and `submit_capture`. This permits only the transport to the existing capture broker/file validation. The computer deny/read-only ceiling, current run authority and broker checks remain in force; no second approval prompt is introduced.

3. **Computer approval compared a dedicated Thread with the Bot's display.** Sync and owner decisions now use the Thread's own device and display `:1`; a source Bot on `:2` or `:3` no longer makes those approvals impossible. Existing digest, run lease, owner, workspace, policy and one-use/run-scoped approval checks remain. A new policy generation still invalidates run-scoped approvals.

4. **Dedicated desktop startup hard-coded policy version zero.** Desktop startup now holds the workspace policy lock, checks the live owner/device binding, refuses workspace deny, and writes the actual policy version. Workspace policy changes synchronize every live dedicated Thread's driver lease as well as the Bot desktop. Without this synchronization, an already issued Thread grant could continue using its previous policy generation. Provisioning, explicit end and desktop startup lock the parent run before its machine to avoid opposite lock ordering.

The claim's existing composition keeps CLI read-only/deny ceilings, repository-specific push approval and the separate computer policy. Browser operations, credential operations and CLI tool approvals remain distinct, owner-bound ledger paths. This focused review found no additional confirmed failure in those dispatch paths or the hosted runner's shared close/revocation promise.

## Validation

- Application TypeScript check and daemon TypeScript check passed.
- Focused lint and `git diff --check` passed.
- Real Claude SDK with synthetic CLI subprocesses: **16 tests passed**, including all four evidence callback registrations, replay denial and the existing computer policy cases.
- Computer broker, stdio proxy and capture-copy regression suite: **29 tests passed**, including real local sockets/subprocesses, capture transport, policy deny, exact approvals and path replacement handling.
- Added behavioral regressions to the existing real PostgreSQL suites: dedicated capture selection and save-before-kill; Thread approval scope and policy-generation changes; desktop policy version, device/owner isolation and concurrent workspace revocation.

The PostgreSQL suites require the final disposable GitHub Actions database gate and were **not executed locally**. No external E2B, Telegram or credential service call was made. The local subprocess tests use deterministic fixtures; they do not claim live provider acceptance.
