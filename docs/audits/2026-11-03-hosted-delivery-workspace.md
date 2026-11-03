# Hosted delivery workspace — 2026-11-03

The owner authorized both existing subscriptions under Mikka account
`alexjiang20232024@gmail.com`: Claude Code (`alexjiang612@gmail.com`) and
ChatGPT/Codex (`alexjiang20232024@gmail.com`). This supersedes the earlier
Flash-only acceptance instruction for this run. API-key fallback was disabled
through the normal owner setting before dispatch. No new provider credential
or identity was created.

## Reproduced on actual E2B machines

A normal authenticated session created workspace
`887238ef-410c-4c65-bb08-cfa15e1f8ec9` and two disposable Bots:

- Claude: `d6bf6e81-2ff8-4f2d-ad94-003d94b934bb`.
- Codex: `c73c8059-b9bf-469c-8d27-22301ae3e475`.

Normal Bot wake allocated E2B parent `ipfdehbc0ws7qjyulcz1o`, with baked worker
digest `69673aa579c9242bbb0446dda8ca178c209dfd32`. The production application was
initially deployment `dpl_5TJMia7nZ4GJsEW4Z839RB7UvVSg`, source
`47286cc30cb03c567d8918360f266478dacb434d`. The shared production alias can move;
these observations do not claim an immutable candidate acceptance run.

After an incorrect repository dispatch was corrected to the supported
`dispatch_bot_computer` tool, both real subscribed Bot chats dispatched fresh
read-only reports. The requested commands were `uname -s`, `pwd`, Python
arithmetic and a separate arithmetic assertion, followed by independent review,
verification and waiting for owner acceptance. No remote repository was needed.

| Harness | Issue | Execution run | E2B task machine |
| --- | --- | --- | --- |
| Claude Code | `b975a728-1f44-444c-8dec-39b3dfa55be7` | `872258c6-71a1-4390-87af-2a97d9c05086` | `ihlo68mksabxldahw98c5` |
| Codex | `98a96b2f-d5a3-48ee-a245-b164bfab51ff` | `7eaaa7fe-feb6-4e2a-865a-38f4dbfacdea` | `io95ezi4vpcbl2x8toxk1` |

Both workers rejected execution with **Repository URL required; dispatch a new
thread.** The actual daemon logs and normal Factory task API agree. No CLI
task session, independent review, independent verification or acceptance
occurred in these two runs. Their bounded retries subsequently lost their
device; those failures remain recorded. Earlier writable attempts also retained
policy-distribution and subscription-initialization failures; opening a native
session during a repair is not proof of task success.

Occurrence **8** × impact **8** = **64**: both supported provider harnesses fail
the ordinary standalone report path before execution. This blocks the remaining
real-provider evidence for PR #1122 and is related to #1124's hosted routing
acceptance. The protected Acme sandbox was not connected to or modified.

## Root cause and change

Read-only execution intentionally has no interactive computer grant. The
daemon's hosted-workspace check admitted desktop runs and read-only independent
checks, but omitted execute-stage deliveries. Consequently a registered,
server-owned delivery workspace was rejected as though it were a local run
missing a remote repository. In addition, a fast claim can arrive after server
registration but before the daemon's next repository-list refresh.

Admit the server's `factoryExecuteKind: deliverable` marker under its read-only
policy and hosted execution mode. Refresh a missing hosted registration before
the synchronous repository check. Still require the claimed repository ID to be
in the authenticated server's registration list. A read-only flag by itself
does not grant workspace access; expected-origin checks remain enforced, and no
computer permission is added.

## Verification and release boundary

The two new regression cases initially returned the exact production error.
With only delivery admission fixed, the late-registration case still failed
through `runs.start`; refreshing the registered workspace fixes that second
failure. Both tests also verify that removing the server delivery marker still
refuses a repositoryless read-only run.

All 50 daemon run tests pass, including independent review/verify fixed-snapshot
and approved-origin mismatch checks. Daemon typecheck and `git diff --check`
pass. Root lint intentionally excludes packages; an explicit lint of the two
files reports three unchanged `no-useless-spread` warnings elsewhere in
`main.ts`, with no diagnostic in the changed lines.

These are deterministic regressions, not a real-provider success claim. The
E2B worker template must be rebuilt and released before fresh Claude and Codex
tasks can establish end-to-end execution, independent checks and owner UI
acceptance. PR #1122 remains pending that evidence.
