# Native subscription runtime tools — 2026-11-03

Fresh normal-owner requests used the explicitly authorized CC612 and
ChatGPT/Codex20232024 subscriptions, with API-key fallback disabled. Actual E2B
parent `itiox5ytks7x0va7m3mn8` used desktop template `bbw9suxdnvm90pvuwrag`.
Its `/opt/mikka/worker-source-sha` was independently read as
`bd611569890535a07b1feef62dd42223160e4712`, after worker release
[41648407424](https://github.com/alexj11324/Mikka/actions/runs/41648407424).
Production deployment `dpl_FTBGPuhQnnbnGMnmXmrqc6VmDsDP` was READY at source
`6e8081033c13d0f71bf09c2fc8fe23c402e35e1b`, and the formal domain's version
endpoint returned that deployment.

The #1128 fix allowed real read-only delivery execution to reach both native
CLIs. This is progress beyond the original repository rejection, not completed
Factory acceptance.

| Provider | Run | Actual native session | E2B task VM | Result |
| --- | --- | --- | --- | --- |
| Claude Code, `claude-opus-5-5` | `863db18e-68ca-46e3-8942-f7c909107577` | `f3f00902-863f-4046-a85a-601ae62f031b` | `iit4z70j5hb6pkg49raw6` | cancelled without a submitted report |
| Codex, `gpt-5.6-luna` | `212c1de2-4f71-44ec-8b55-53ec8bab2698` | `01a1a1ba-1861-70d0-86a6-8d719d436f7a` | `i1p9fkxqbvapazh7cfwjq` | blocked without a submitted report |

Both assignments were subscription-bound, read-only deliveries without a
computer grant. The issues requested actual `uname -s`, `pwd`, Python arithmetic
and an independent arithmetic check, then independent review/verification and
waiting for owner acceptance. Neither reached those later stages.

## Observed failures and narrow fixes

**Codex tool discovery.** The real response reported
`codex-code-mode-host: No such file or directory (os error 2)` and could not
call even `submit` or `report_blocked`. The official pinned Linux x64 0.163.0
tarball was fetched and its complete SHA512 verified against existing pins. It
contains `vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host`; the installer
extracted only `codex` and discarded everything else.

Declare that required sibling in the same pin; extract it only from that same
verified tarball. The install marker includes companions, and missing companions
invalidate an old main-only installation. Add the absolute host-selected CLI
directory to local and hosted filtered PATHs so Codex can discover the helper.
No version, model, credential or execution permission is changed.

Occurrence **9** × impact **8** = **72**: the current pinned Codex cannot discover
MCP tools in the demonstrated read-only native run without its bundled helper.

**Liveness error classification.** At 14:05:00.402Z Claude's tool-approval route
returned 409 with `reason:error` in 2047ms; surrounding checks returned 200/live.
The native session was then cancelled. The old log did not retain the exception
type, so attributing that individual error specifically to a fence timeout or
SQL failure would be speculation.

The handler demonstrably caught typed device-fence failures and revocations
before `withDeviceRoute` could classify them: both were incorrectly returned as
409. Preserve the wrapper's 503 for an unavailable fence and immediate 401 for
revocation. Allowlisted transient SQL states also return 503 without a liveness
grant; existing daemon code waits and rechecks for its bounded grace period.
Unclassified errors, unavailable runs and policy changes still refuse as before.
Only bounded allowlisted SQL-state diagnostics are added, never messages, stacks,
causes, headers or credentials. No client-side authorization fallback was added.

Occurrence **7** × impact **8** = **56**: any demonstrated infrastructure refusal
misclassified as an authoritative 409 permanently cancels an otherwise live run.

## Verification and remaining boundary

Installer and bootstrap regressions failed before the respective fixes. Final
46 native/installer/liveness tests and five real-route/error-classification
tests pass, including immediate revocation and unchanged policy denials.
Application and daemon typecheck, targeted application lint and diff check pass.
The actual verified 0.163.0 artifact was installed in a disposable local harness
directory: `codex --version` and `codex-code-mode-host --help` both executed.
These commands make no model request.

Both failed task machines were ended using the normal owner API and the owned
parent paused; history and safe logs remain. No existing user Bot, connection,
workspace machine or protected Acme sandbox was modified. Fresh tasks after
release must establish actual execution, independent review/verification and
owner UI acceptance before #1122 can claim end-to-end completion.
