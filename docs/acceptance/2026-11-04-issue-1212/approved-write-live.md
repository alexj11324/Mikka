# Approved-write cards use committed invalidations

Issue: #1212. This change covers the three ten-second reads in `components/coordinator/approved-write-actions.tsx`: availability, the unresolved infinite list, and an uncertain/running proposal's result. The legacy `pending-actions` list is a separate change.

## Read and write contract

The existing owner-bound proposal, authorization, operation ledger, provider invocation and uncertain-result recovery remain authoritative. A notification never approves an action, retries a decision or repeats an external effect. Actual proposal inserts, successful declines, the transition to running and a committed successful ledger result register invalidation only after the outer transaction commits. Replays, ordinary reads, invocation bookkeeping and an uncertain outcome do not produce false state changes.

The publisher resolves the proposal in its original application database and the owner's active personal workspace after commit. It sends only `approved_writes` plus the personal workspace UUID, and `approved_write` plus the proposal UUID, to that owner's channel. It does not publish to other members of a team. A rollback discards the notification; revoked membership suppresses a delayed publication.

The browser reuses the authenticated workspace-switcher cache to find that owner's personal workspace. An unresolved workspace keeps the slow read fallback and never guesses a live ticket. The list uses SWR Infinite's actual serialized cache key, including owner and session, so one event refreshes all loaded pages. A card's result key also retains session, action and proposal identity.

## Compatibility and expiry

A browser WebSocket receives a small `live_ready` frame containing protocol version 1 and the deployed Worker's supported kinds. The client stops the sixty-second fallback separately for each supported kind. An old Worker without the frame, an unsupported kind added later, or a malformed frame retains fallback even if the socket and auto-pongs remain healthy. Daemon connections and the existing hibernating auto-pong path are unchanged. The common channel/deadline code is extracted from #1236; later integration must preserve these same helpers and the union of live kinds.

An approval's server read time and the browser's monotonic request-start time define its remaining lifetime. Network delay and renders cannot extend it. A one-time deadline causes an authoritative list/result read; the actual decision still checks server authorization and expiry. The browser runtime uses a monotonic clock for deadlines and read pacing, while ticket expiry keeps its existing epoch clock. Hidden pages make no polling reads and reconcile on return.

Availability is a server capability hint. Initial load, normal focus/reconnect and proposal invalidations reread it. A changed value from the existing PostHog flag callback also invalidates the hint; repeated callbacks with the same value do not issue reads. A browser flag evaluation is not the deployment's server evaluation, and this is not a claim of an instantaneous deployment-wide kill-switch broadcast. Every POST preserves its existing server-side kill-switch check.

## Verification and remaining acceptance

The local evidence uses the existing Large Docker sandbox, Node 24, PostgreSQL 17, a local production build for screenshots, and normal leased TestPool identities. The database regressions use full tracked migrations, real transactions, a loopback receiver and a controlled provider fixture with no external effect. They cover commit/rollback, uncertain-result recovery without resend, another owner, membership revocation and delayed callbacks with identical proposal UUIDs in two databases.

The independent #1260 migration is a prerequisite: full-migration approval testing exposed the existing account-deletion workspace trigger casting the ledger's valid `personal:<owner>` scope to UUID. This PR does not disable the trigger or change ledger ownership.

Local gate details, exact source commit and screenshots are recorded with the PR. Production Web deploy, exact `/api/version` build, the corresponding existing Worker release, real production acceptance and issue-level traffic measurement remain separate required evidence. Unit/PG/workerd results and local screenshots are not represented as production or fixed-task-hour acceptance.
