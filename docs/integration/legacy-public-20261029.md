# Legacy public backlog composition

Baseline: `142e1304f5d647264ffa62fdce37b1fab2222003`.
This lane reviews #287, #300, #301, #304, #308 and #313 against current main.
It does not import their old integration branches as a whole.

| PR | Disposition | Evidence |
| --- | --- | --- |
| #287 `fe0c9152` | Keep current personal message/mailbox implementation. Exclude the inherited enterprise audit/export stack and old native group executor. | `docs/backend/personal-message-safety.md` explicitly records the extracted #287 public source/provenance work and says the old full branch is not a dependency. Current `personal-mailbox-*`, `session-mailbox`, and cancellation-safe transaction helpers retain owner/frozen-grant authority. The old tip's rejected-BEGIN fix affects `lib/db/device-scope.ts` and `lib/group-review-access.ts`, neither of which belongs to the current implementation. Current `writeTransaction` tracks whether BEGIN succeeded and preserves the original error. |
| #300 `e4e90146` | Port durable Telegram source receipts and APP connection reuse into the current Coordinator. Preserve current round implementation and clarify its per-generate scope. | Main already has `AGENT_MAX_ROUNDS=120`, its warning/last-step rules and current Bot wiring. The missing behavior is recovery of Telegram destinations after an already-consumed turn fails. Original parent `25d3d1ba` includes organization policy, tenant quotas, audit and a different wake schema; those dependencies are not imported. |
| #301 `1682ed09` | Covered by successor #365, composed by the scope/frontend lane. | `git merge-base --is-ancestor pr/301 pr/365` succeeds. #365 retains its scope store, team creation and run-completion implementation and adds newer explicit-sharing/retirement fences. Do not replay the earlier migration aliases. |
| #304 `1001971b` | Safe authentication diagnostics are already present; retain current workload and account-vault architecture. | #304 `lib/credentials/universal-auth-diagnostics.ts` and main `lib/infisical-auth-diagnostics.ts` have identical bytes. Main `infisicalWorkloadToken` invokes that classifier and never returns raw failure text. The old one-time credential broker/cleanup chain is superseded by account-vault #345; importing it would create competing credential services. |
| #308 `42f0d5c4` | Retain current approved-write implementation and subsequent policy wiring. | Current `approved-writes.ts` preserves canonical intent UUIDs and rejects case-duplicate proposals. Current `ledger.ts` preserves normalized operation locks. `write-target.ts` and `session-authorization.ts` are unchanged from #308; current provider code additionally rechecks Notion target/account at the send boundary. Current route/view/discovery and transaction cancellation logic extend the candidate. Older tool registration and duplicate migrations are not restored. |
| #313 `77c9984a` | Retain current owner-only thread access and test-account lifecycle. Exclude inherited enterprise audit/export/disposal and obsolete R0 runner composition. | The branch mixes 276 commits and 592 changed files, including `lib/audit`, audit exports, the old credential system and private disposal recipes. Main uses the tree-aware mandatory DB inventory, current owner-only run controls, and automatic leased test accounts. Its current suites must remain enrolled; replacing that inventory with the old branch would regress coverage and reintroduce retired runtime code. |

## Telegram behavior

Newly consumed authenticated Telegram events carry a small versioned pending
receipt in the existing event payload. Enrollment and inbox consumption share
the same transaction. Old delivered events without that receipt are not replayed.
A later successful turn can answer a destination retained by an earlier failed
turn. Acknowledgement names the exact source-event IDs, so it cannot clear a
newer message for the same destination. No new table or migration is needed.

Each chunk checks the current chat lease, exact source events and account link.
Issue parents are locked before event children. Source tasks remain subject to
current ownership and, for nonowners, active team membership; membership and
source locks remain held during the send. Bot calls additionally recheck their
owner and workspace. The Chat SDK joins that APP transaction instead of borrowing
another connection. A verification-code handoff still suppresses Telegram output.

Successful empty Telegram turns record a fallback reply rather than dropping the
destination silently. Telegram does not support an idempotency key: response loss
after a send can still be externally uncertain. This change does not claim
exactly-once delivery or repair the separate autonomous wake scheduler.

## Verification

- Current application typecheck passes after sharing the installed workspace
  dependencies; focused oxlint and `git diff --check` pass.
- The pending-receipt, event, Telegram text and round suites pass.
- Existing AgentKit entry, message-safety ingress/consumer and summary-model
  consumer suites pass with their synthetic dependencies.
- The mandatory `test:bot-chats-db` suite now includes actual PostgreSQL recovery,
  old-ACK/new-message separation, stale owner/holder/destination, link revocation
  and release rejection. This test uses a send callback, never Telegram, and
  retains its new synthetic rows. It must pass in final isolated CI; it has not
  been presented as an already executed live-provider or database acceptance.
- No credential, provider request, production SQL, cloud configuration or remote
  repository mutation is part of this lane.
