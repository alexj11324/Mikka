# Backend consolidation — 2026-10-30

This branch combines five backend changes for one review and one integrated
CI/browser/performance gate. It does not merge or deploy them to production.

## Frozen inputs

Initial base: `17ad65a07043bafef09d5409f771a1867858b2c3` (`main`).
Combined implementation and migration-order revision:
`a2bc2ec7721c75ecdd6e97ed0553e62101dbaa82`.

| Issue | Source PR | Included source head | Resulting behavior |
| --- | --- | --- | --- |
| #499 | #516 | `1a136c26cebac70d2d78dbf468998a65bbfd38c6` | Transactional issue numbering and unique owner/number pairs |
| #494 | #517 | `316ed5c9b50cb6f7fbf0bb342e0f3454dee0d375` | Approval reserves and starts publication with durable effect ownership |
| #176 | #518 | `beed9c247e291ca0c2d1b695eded8034fff17f36` | Persisted wake retries, bounded backoff, exhaustion and explicit replay |
| #500 | #519 | `800e46f2d9f32fdc8f22f85d80b909e4fe5f828d` | Execution agents obtain scoped GitHub credentials and own push/PR/CI repair |
| #178 | #521 | `f803ab4679ed07ad8d9d97fa09c031ccf1b0bcb8` | Device credential revocation fences writes and cancels attributed active runs |

The base already includes #520. Its implementation remains with its original
owner. Integration retains its task-secret/model-selection behavior and capture
evidence tests; it does not take on additional #520 work. Other open frontend
and onboarding PRs are outside this batch.

Main subsequently merged onboarding backend PR #522 at `d9d7b55a`. This
branch also synchronizes that upstream revision, retaining its implementation
and mandatory tests. Conflicts only required the union of package scripts,
database inventory and CI suite names. Its migration precedes this batch's four
candidate migrations; the final fresh bootstrap has 145 migrations. Onboarding
work remains with its original owner.

The first full browser run on the synchronized revision found an outdated
monitor HTTP assertion: it expected a different legacy candidate display field
to reject an otherwise current lifecycle request. A8 intentionally uses task
ID and revision for that decision. The test now sends a mismatched revision,
still requires HTTP 409 and verifies that rejection leaves the task revision
unchanged. Owner, replay, STOP and access checks remain. This fixes a guaranteed
integration-gate failure (occurrence 10/10, impact 3/10), without changing the
server contract or weakening the expected rejection.

The browser contract fixtures also distinguish a legacy failed publication
still in the publish stage from a failure returned to approval. The former
keeps its existing display coverage; the latter must show pending approval,
offer no direct publish action and send a fresh approval request without
reusing the failed approval ID. This corrects an outdated fixture default and
adds coverage for the A3 recovery behavior without changing product components.

An additional daemon startup race was reproduced while investigating one SSH
CI timeout. If login occurs after the daemon reads its old device file but
before RPC opens, the old CLI saves the credential and reports success while
the running daemon remains unregistered. The integration includes source fix
`008f95af96ffe12fbd04231f124b986dd03a9ce9` (cherry-picked as `c0470cee`).
After persisting an offline login, the CLI checks the daemon's live PID and
hands the credential to an already-starting process through authenticated RPC.
It uses the existing six-second startup bound. It does not reload credential
files into a live daemon or extend the SSH installer's thirty-second check.
The reproduced product risk is occurrence 3/10 × impact 5/10 = 15. The earlier
CI timeout lacks a remote journal, so its exact cause remains unconfirmed.

Four deterministic startup regressions cover first login, replacing an old
credential before RPC readiness, clearing a session without reviving old file
contents, and a live process that never opens RPC. On the integration tree,
these and command/HTTP credential regressions passed 33/33; daemon types, lint,
the self-contained build and its fresh-tarball installation/git-task test also
passed. Logs: `/tmp/mikka-aggregate-startup-{tests,types,package-build,package-test}.log`.

Focused Factory Chromium validation also passed all six spec files, 13/13 with
the four design-evidence cases enabled. Tests ran at `3098e18a` plus the locator
correction now frozen in `6503b776`, against the unchanged application build
`9673e928`, isolated PG17 with 145 migrations, real deployment attestation and
automatic account leases. Thirty evidence artifacts passed the existing secret
scanner, and the test server stopped normally. Log:
`/tmp/mikka-factory-browser-3098-fixed/playwright.log`.

## Integration decisions

- Keep both #520 capture-evidence and #494 approval/publication test cases.
- Preserve the union of package scripts and mandatory database-suite inventory,
  including current-main settings/execution rules and device revocation.
- Keep both model redetection and credential-rejection handling in the daemon.
- Keep claim-response coverage for task secrets and exact device-token attribution;
  retain the GitHub runtime descriptor and hosted task environment together.
- Keep the revocation fence on the same SQL connection as the authorized write.

Four unmerged migrations were renamed after the base's latest migration. Their
SQL bytes are unchanged. Already-merged migration files and existing database
ledgers were not rewritten. Fresh isolated databases bootstrap the combined
144-migration initial history (145 after the upstream #522 synchronization).

| Candidate filename before integration | Filename in this branch | Unchanged SHA-256 |
| --- | --- | --- |
| `20261030203400_issue_number_counter_expand.sql` | `20261030213400_issue_number_counter_expand.sql` | `dcebd6c3d9fd4ec923958f4c19dcfa87c2422f3a83317b79d052768041e8db03` |
| `20261030203401_issue_owner_number_unique.sql` | `20261030213401_issue_owner_number_unique.sql` | `940f564d977aaf7d0c7b17d27ac185052d81b2880ad696e8d47a2fb5a4700d11` |
| `20261030203541_coordinator_wake_recovery.sql` | `20261030213402_coordinator_wake_recovery.sql` | `251917c12499d5172deaeb764bd11e0c3a6b0cece46bf3fe287b93cfba28c2d7` |
| `20261030203814_daemon_credential_revocation.sql` | `20261030213403_daemon_credential_revocation.sql` | `083c044fbd62244565bd64e6aef3852a0bb3069cc5e2ef1d8f6de9b48d94804a` |

## Fixed-revision verification

Cloud Linux, local PostgreSQL 17, no shared or production database. Commands
ran from this worktree, with `@mikka/protocol` resolving to its own package.
The following results apply to `a2bc2ec7`. Its immediate successor adds only
this evidence document. The later synchronization with #522 adds onboarding
schema and code; final combined CI must run on that synchronized head.

| Verification | Result | Retained local log |
| --- | --- | --- |
| Fresh schema and Better Auth bootstrap | All 144 migrations applied | `/tmp/mikka-aggregate-numbers-setup.log` |
| Issue numbering and run-chain real PostgreSQL tests | 23 passed, zero skipped | `/tmp/mikka-aggregate-numbers-matrix.log` |
| GitHub authority/exchange real PostgreSQL runner | 11 passed, zero skipped | `/tmp/mikka-aggregate-github-500.log` |
| Factory approval/publication/capture/reject/public consumers | 60 passed, zero skipped | `/tmp/mikka-integration-factory-approval-db-a2bc.log` |
| Factory source/evidence/state/provider protocol tests | 27 passed, zero skipped | `/tmp/mikka-integration-factory-source-a2bc.log` |
| Factory monitor/normal dispatch/V2 | 24 passed, zero skipped | `/tmp/mikka-integration-factory-monitor-a2bc.log` |
| Factory lifecycle/routing/store | 29 passed, zero skipped | `/tmp/mikka-integration-factory-lifecycle-a2bc.log` |
| Bot chat and durable wake real PostgreSQL tests | 14 passed, zero skipped | `/tmp/mikka-backend-wake-real-db.log` |
| GitHub credential helper | 6 passed | `/tmp/mikka-a2bc2ec7-github-helper.log` |
| Daemon runtime/proxy/adapters/network | 123 passed, 9 existing conditional skips | `/tmp/mikka-a2bc2ec7-runtime.log` |
| Hosted task environment | 4 passed | `/tmp/mikka-a2bc2ec7-task-env.log` |
| Mandatory database-runner inventory | 15 passed | `/tmp/mikka-aggregate-db-registry.log` |
| Copy-policy regression tests | 4 passed | `/tmp/mikka-aggregate-copy.log` |
| Root TypeScript | Passed | `/tmp/mikka-aggregate-typecheck.log` |

Independent SQL reads confirm a valid unique owner/number index, no duplicate
owner/number pairs and no counters behind existing issues. The GitHub runner
uses real authorization/database paths and an explicit external-provider
fixture; it does not establish live GitHub App acceptance.

The PR's Git-linked checks are the authoritative combined source/build/database
and browser results. A ready `integrate/` PR must run full functionality and
desktop/mobile performance under the existing policy. Draft skips, source-PR
green checks and local fixtures do not satisfy those combined gates.

## Acceptance still required

- #500: the authorized workload's `/vercel/GITHUB_APP_PRIVATE_KEY` lookup
  returned HTTP 404. Real App issuance and a native agent creating a PR,
  observing failing CI, repairing it and reaching green remain unverified.
  Existing workstation GitHub authentication does not prove this path.
- #176: deploy the updated existing cron Worker after application migrations;
  verify production scheduling and original-chat recovery after model/effect
  failures. Wake-delivery tests do not prove exactly-once external effects.
- #178: legacy active runs without device-token attribution are reported
  explicitly. Real native-agent stop timing and the complete account-pool HTTP
  acceptance matrix remain unverified; no guards were weakened.
- #494 and #499: source and isolated-database acceptance are recorded above;
  the combined PR still needs its selected runtime and migration gates.

These gaps are not automatic issue-closing claims. Source PRs can be marked
superseded once the combined gate passes; supersession is not a claim that
those individual PRs were merged or their parent issues fully accepted.
