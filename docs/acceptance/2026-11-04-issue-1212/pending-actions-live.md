# Legacy pending-action cards use committed invalidations

Issue: #1212. This change replaces the ten-second `PendingActions` list interval with the existing authenticated LiveChannels protocol. It is stacked on #1269, which owns the common per-kind capability handshake, monotonic read pacing and expiry observation protocol. The three approved-write reads remain a separate change.

## Existing authority and visibility

The GET still returns the existing array and applies the same session-owner and personal-access-token filtering. It adds a viewer identity header and the server time observed before reading. The browser verifies that identity before caching under its owner/session key. A response from a switched login cannot enter the previous owner's cache.

The list is owner-wide. After a real write commits, the publisher rereads the proposal by ID and owner in the source application database and selects that owner's actual personal workspace with active membership in the workspace database. It sends only `pending_actions` and the personal workspace UUID to that owner's existing channel. It never uses the currently selected team's membership to grant access or exposes proposal inputs, account data or source IDs on the wire. Missing personal scope retains the slow fallback and creates no guessed workspace.

## Actual mutation coverage

| Writer | Notification boundary |
| --- | --- |
| `proposeAction` | Actual pending INSERT; direct running account writes remain quiet. |
| `proposeAppToolCall` | Actual pending INSERT after existing validation and account selection. |
| `decidePendingAction` | Existing owner/pending/TTL atomic transition returns a changed row. Repeated and foreign decisions do not publish or execute. |
| `proposeCredentialOperation` | All writes in the original transaction succeed. A later failure or rollback discards the notification; login and replay paths stay quiet. |
| `sweepBrowserMutations` | Only expired rows actually changed by UPDATE RETURNING. Repeated empty sweeps are quiet. |

The dependency extracted from #1236 adapts the observed native client, held request pool and Drizzle transaction to the actual outer COMMIT. It preserves savepoint rollback and request AsyncLocalStorage through delayed scheduling. The production callers use the existing application/request database proxies or their held clients; this is not a promise to infer a request database from any arbitrary independent Pool object. A closed source scope fails closed instead of using the default database.

## Timing and recovery

A supported live kind disables the old ten-second interval. Disconnection or a Worker without the required capability retains the shared sixty-second fallback. Focus/reconnect and returning from a hidden page reconcile through the existing channel; hidden pages do not poll.

Account/app cards retain seven days; credential/browser cards retain five minutes. The deadline uses the server observation and the monotonic time captured immediately before the real HTTP request. Latency can make the check earlier, never later. A newer authoritative response that still reports positive remaining server time may rearm an already-fired conservative deadline for the same expiry. A running timer is not postponed, and stale cache/render/server-expired results cannot form a repeated immediate-read loop. The same subscription, ticket and socket are retained. The decision endpoint's actual ownership, TTL and atomic authority are unchanged.

No notification retries a decision or creates an external effect. The existing inline load error and explicit retry remain available.

## Local verification and limits

The actual final source was integrated onto #1269 commit `61545e2cfc9cd90e445a442c2762cb5ccfe6b4f1`, including main `eb0c5cb`. Only package.json required a textual three-way resolution; there were no conflicting semantic keys, and all existing main gates remain. The 17 code/test files were verified byte-for-byte against the Vercel Git index before this documentation file was added.

In the authorized Vercel Sandbox, Node 24.22.1 / pnpm 10.34.3 / PostgreSQL 17.11:

- Pending cache tests: 4/4; actual React/SWR plus route-wiring tests: 7/7; approved-write compatibility: 96/96.
- Full live PostgreSQL: 35/35, including the new actual mutation/outer COMMIT/savepoint/rollback/cross-database tests. Existing unattended PostgreSQL: 13/13. No skipped database cases.
- Device gateway tests, including 9 real workerd cases, typecheck, lint:code and diff check passed.
- The old shared deadline implementation failed the real pending React early-expiry case; the fixed shared implementation passed without shortening the server TTL or weakening its assertions.
- Independent review read all 17 changed files and 19 exact base files. It found no blocking issue in the inspected scope; that source review is not presented as a separate execution of these tests.

The first replacement-sandbox full live run correctly failed because the new base test database lacked the tracked workspace schema. The repository's normal database setup was applied and the unchanged suite then passed. The original environment failure remains recorded. Browser models, provider calls and production state were not used by these gates.

The route-wiring unit tests mock the session and token filter, so they are not a claim of a new end-to-end authentication test. Actual authority continues to use the unchanged production path. Normal production-build screenshots, the exact public PR head and CI are recorded separately. Production deployment, the matching existing gateway Worker, exact public build, real production operation/focus/reconnect checks and the issue's traffic gates remain required; local results do not replace them.
