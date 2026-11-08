# One task, one machine; execution authority stays on the machine

- Date: 2026-11-06 18:00 UTC
- Source: Alex's [decision on #1505](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691833153) and [the explicit replacement of the old credential rules](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691871552).
- Rule: Cloud execution, local daemon execution, credential delivery and startup acceptance.
- Superseded by (only for non-CLI third-party Secret exposure): [2026-11-08-0240](2026-11-08-0240-credential-exposure-boundary.md). All other execution and performance rules here remain in force.
- Replaces: the extra runtime isolation, placeholder/provider proxy, per-call remote authorization and credential cleanup requirements in [orchestration §§3, 5–6](../orchestration.md); the corresponding parts of [1312](2026-11-01-1312-cloud-runs-without-docker.md), [2335](2026-11-01-2335-e2b-official-templates.md), [2225](2026-10-31-2225-bindings-belong-to-the-person.md) and [1600](2026-11-02-1600-agents-use-own-github-credential.md). Account ownership, the selected model, billing attribution and workspace sharing rules remain in force.

Alex's words, as recorded in the issue:

> 「本身我们现在就是一个任务一台机器，你的这个安全隔离做法就已经是错误的了，你还在错上加错。本身这个东西一个任务一台机器就已经非常安全了。」

> 「我要求就是说权限完全下放到机器，不应该再这样做，就像服务器确认有没有权限了……这样已经非常严重的干扰到我们的正常工作流了，你应该撤销掉。……绝对不允许出现就是说你为了安全降低效率。」

> 「你除了 CC 和 Codex 本身的启动之外，你其他的凭证之类的……你通通应该提前给他。隔离环境甚至都不需要，因为我们现在已经是一台机器一个任务了。」

The second comment explicitly replaces the older claim that a subscription
never leaves the server and that the Agent must hold a placeholder while
Mikka checks and forwards every model request. It also requires before/after
per-call timing evidence before removing that proxy path.

**Scope correction (2026-11-08):** The quoted instruction is retained as
historical context; it does not authorize disclosing every user/workspace/
repository Secret to a task Agent. The updated
[credential-exposure boundary](2026-11-08-0240-credential-exposure-boundary.md) distinguishes selected
native CLI/GitHub credentials from other third-party Secrets. No repeated
per-model/per-tool Mikka control-plane checks are reinstated.

## Cloud execution

One thread task owns one E2B VM. That VM is the boundary between tasks; no
other task or owner uses it. Claude Code and Codex run directly as the
machine's normal user, with its normal HOME, environment and Git repository.
Do not add a container, a second sandbox, a shadow `.git`, an isolated HOME,
a blanket environment filter around native CLI execution or an isolated
GitHub configuration inside it. This does **not** exempt unrelated task Secrets
from scoped, non-readable delivery.
Verification commands use the same repository too. A read-only task remains
an instruction to the Agent, not a reason to manufacture another repository.

Prepare only the task's **selected** native CLI subscription login/model
key and approved GitHub execution credential while preparing the machine,
or once on the first request that needs them. Do not treat this as a grant to
inject all other user/workspace/repository Secrets into the Agent environment;
those follow [2026-11-08-0240](2026-11-08-0240-credential-exposure-boundary.md). Claude Code connects directly to Anthropic and Codex directly
to OpenAI; the Agent can use the credential it was given. There is no Mikka
placeholder, provider-forwarding proxy or extra remote permission check
before a provider or tool call. The ordinary provider protocol, including
its own authentication, stays intact.

The control plane resolves the owner, model, credential, sharing authority,
machine and payer when admitting or explicitly moving work. That recorded
assignment is the machine's execution authority. Removing a share, revoking
a connection or stopping a task pushes a stop to the runner, or stops and
reclaims its VM. Revocation does not wait for the next provider/tool request
to encounter another permission gate. Existing progress heartbeats and
recovery remain lifecycle traffic, not authorization preflights for calls.

A provider token may need renewal when it naturally expires. Refresh it in
the background before expiry and update the running CLI through its normal
credential mechanism. Do not terminate a healthy Claude Code run merely
because the old access token reached its expiry, and do not put another
Mikka authorization round trip on every request. A service operation that
inherently calls Mikka or an app still makes that operation's request; it
does not add a separate permission-preflight request first.

Prepare repositories with shallow or partial clones, overlapping preparation
with machine creation where the source is available. Remove full-history
fetches from the mandatory startup path. No `runtime-git` clone and no
second verification clone is made merely to hide the real `.git`.

### Prepared Git credentials for the initial clone

When a claim already contains the person's GitHub token, the daemon's own
clone/fetch uses Git's standard credential-helper protocol with fixed shell
builtins that read that existing `GH_TOKEN`. It does not launch `gh` merely
to read the same credential. The helper is command configuration only: no
Git/gh executable wrapper, extra credential file, provider proxy, remote
authorization call or change to official files. Existing caller Git
configuration is retained, including inherited `-c` parameters. Prepared
local-device environments and older claims keep their existing behavior;
the ordinary HOME credential preparation, background renewal, stop and
compare-before-restore lifecycle are unchanged. The existing empty-repository
default-branch lookup still uses native `gh` when needed.

The credential keeps the previous `https://github.com` host scope. Normal
same-host repository renames use Git's existing redirect behavior, while
cross-host redirects must not carry the prepared credential. The initial
`http.extraHeader` alternative was rejected after a real smart-HTTP fixture
observed its Authorization on a later cross-host request. Standard
credential-store also retains Basic authentication during a same-host
redirect, so a stricter cross-path rule was not an existing product guarantee
and is not added here. Repository admission and the token's GitHub permissions
continue to control access; this change does not introduce a new permission
check while Git runs. The existing run masker covers the token and its
reversible Basic encoding in logger and terminal output.

The three fresh, no-model repository profiles in workflow
[`42375615582`](https://github.com/alexj11324/Mikka/actions/runs/42375615582)
used the published `1edbeca68711` template and a fixed Handoff commit. They
observed 4.737/4.752/7.512 seconds in the first `gh` credential child, nested
inside clone, with no claim about that child's internal CPU or networking.
These are component measurements with an App token and unknown region, not
production dispatch timing or a measured saving from this change. Real Git
HTTP regression tests prove direct prepared-credential use, inherited-config
compatibility, redirect behavior, authentication failure and partial-clone
cleanup. End-to-end improvement still requires the production gate below.

## A person's computer or server

The local daemon also performs no extra remote authorization check before
each tool or provider call. It keeps the worktree and ordinary task cleanup
needed to avoid damaging the person's repository and unrelated work. It
does not introduce cloud-style containment around the CLI. Stop pushes end
the local task's process group, not other programs on the person's machine.
Any local configuration needed to run parallel tasks must serve actual
correctness and preservation of the person's existing files, not restore
the superseded placeholder/proxy policy under a new name.

## Templates and lifecycle

The reusable public template is still software only. Build and publish it
without any account login, provider key, device identity or workspace data.
Deliver only approved task CLI/GitHub credentials and scoped third-party
capabilities after creating the owner-bound VM. Its normal
private runtime state can remain with that task while paused; it must never
be published as a reusable template or assigned to another task. At task
completion reclaim the disposable machine. Do not erase credentials and
recreate an isolated environment at every turn merely to implement the old
runtime policy. A credential that is no longer usable is replaced through
normal provider renewal or the next authorized assignment.

[Official templates only allow additions](2026-11-03-1430-official-e2b-templates-unchanged.md)
still applies: all Mikka software is installed under `/opt/mikka`, every
original official CLI/software file remains intact, and CI requires both
real subscription runs before template publication. Secret values never
enter source control, logs, reports or reusable artifacts. This decision
does not remove unrelated web-session authentication, account ownership,
test-database boundaries or protection of other people's data.

## Evidence and acceptance

First record the old production path's segmented startup and per-call
authorization/proxy costs. The same PR records the new trace comparison,
including each tool/provider call and the absence of an extra Mikka
authorization round trip. Construction or anonymous worker readiness is a
component measurement only.

The final #1505 gate stays: at least three real production dispatches, all
at or below five seconds from dispatch to Agent execution, targeting two
to three seconds. Use the account and repository named in the issue, record
the exact application/source versions and run IDs, and clean up the test's
own resources. Neither an image checksum nor one successful CLI invocation
stands in for the end-to-end timing.
The start is the first line of `dispatchRun`, before its initial Profile/model
validation, with an explicit `dispatch_run_entry` boundary in the receipt. The
end is the later of the server execution stage and the official CLI's exact
task acknowledgement. Legacy measurements that start inside the dispatch body
are lower bounds and useful phase evidence, not complete-entry acceptance.

## Bootstrap-time anonymous Claude preparation

A fresh TaskVM may initialize one anonymous Claude process after its strict
bootstrap is accepted, before device registration and run claim complete.
The template snapshot never contains this process or its native session UUID.
The server emits the optional, bounded configuration sidecar only when it
actually creates a new official Claude instance with no existing sandbox or
device, for a queued first attempt with no prior start, session, token, retry,
continuation or question-resume state. Retained/adopted machines and runtime
refreshes remain on the ordinary path. The sidecar is bound to the exact
bootstrap bytes and run ID; it contains configuration, never account or task
authority.

The same fresh assignment, policy hash, model/effort, diagnostic scope, normal
HOME/environment and complete MCP catalogue must match before one adoption.
Skills and project/local settings are still prepared and verified at the
final cwd. An isolated owned child executes the existing Mikka MCP backend;
unbound tools refuse calls, and cancellation kills and drains its process
group. The original stdio entry uses that same backend. No tool handlers or
Git semantics are substituted. Only the SDK's specific
`project_settings_not_claimable` refusal can drain and retry the ordinary
path after claim; other permission, identity, account and claim failures
remain failures.

For explicit diagnostics, the same loopback collector is started before the
anonymous process and transferred once to the matching fresh run. Its actual
early timestamps remain intact. `preparationTiming.source =
bootstrap_claude_start` has its own clock and includes the real prewarm and
claim initialization; it is never rebased into the later `agent_start` root.
The closed `observedAuthSource` records the actual native account-info source
(environment OAuth, descriptor OAuth, unspecified non-API-key, or unknown),
without exporting an arbitrary native string. The closed `claimAuthentication`
field distinguishes verified
`oauth_environment`, the original `ordinary_path` fallback, and
`unverified`. The formal reader rejects missing or unverified authentication
for this new source, while retaining the original CLI-initialization, exact
ACK, dispatch-entry and five-second requirements. Ordinary tasks add no
detailed timing fields.

Installed SDK 0.3.305 documents fresh OAuth/session additions in
`ClaimOptions.env`; its `AccountInfo.tokenSource` is a string, not a published
enum, and this package contains no native `cli.js` implementation. The new
account guard accepts only `firstParty` and the existing non-API-key checks;
the additional exact `CLAUDE_CODE_OAUTH_TOKEN` source is allowed only after
this candidate's successful one-shot claim. Offline real-SDK/IPC fixtures
prove protocol and refusal boundaries, not what an official native binary
actually reports. The existing subscription candidate gate uses a personal
acceptance daemon without a bootstrap sidecar and therefore validates the
original FD3 route. Its success does not validate anonymous adoption. The
subsequent real production dispatches must exercise and report the actual
new source; no native-source value or performance saving is inferred.

## Bootstrap-time anonymous Codex initialization

A fresh, never-assigned Codex TaskVM may send only `initialize` and
`initialized` after accepting the same strict bootstrap. It does not log in,
start a thread, or send task input before the normal fresh assignment and
final checkout are available. This is restricted to the verified 0.166.0
protocol. Other native versions, custom environments, existing HOME settings
or credentials, project `.codex`/`.agents` layers, and unverified worktree
metadata use the original path after the speculative process has closed and
drained.
The existing model, account, approval, ledger and resume checks remain in
their original order; an actual login or authority failure is never retried
as a different session.

The process starts only from an absent user Skills directory. Codex itself
installs embedded system Skills under `CODEX_HOME/skills/.system` during
initialization. The candidate snapshots only this bounded, owned, non-linked
directory and requires its contents to remain unchanged before adoption.
Added user Skills or changed configuration are not ignored. The native
process retains the ordinary HOME. When the checkout is beneath HOME, only
the exact canonical `HOME/.codex` already checked by the dedicated user
configuration guard is excluded from project-layer traversal. `HOME/.agents`,
all other ancestor configuration, the actual parking directory and symlinks
still require the original cold path. A normal Git worktree is eligible only
when its bounded, owned, no-follow `.git`, `gitdir` backlink and `commondir`
files agree with the primary clone already proven by the supervisor. The
primary checkout and its ancestor configuration are checked too: the native
loader can obtain project hooks there. Changed metadata, a foreign common
directory or worktree-specific configuration drains the spare before the
original cold path. The final thread receives its actual
repository cwd, original dynamic mailbox tools and the complete Mikka MCP
configuration. MCP secrets stay in an owned, immutable 0600 context file
outside native thread configuration; the original stdio implementation reads
it through a bounded no-follow entry, including legitimate MCP restarts.
The file is removed when the owned process group is drained. Leader exit
also stops that group immediately, including descendants holding inherited
pipes; completion still waits for the real child `close` event.

For opted-in diagnostics, `preparationTiming.source =
bootstrap_codex_initialize` records the actual earlier initialization clock
and transfers the existing local collector once to the matching run.
Authentication is still measured on the later ordinary login path; this
source does not claim an early OAuth login. Missing, malformed, mismatched or
truncated preparation evidence still fails the strict initialization reader.
No receipt is added to ordinary diagnostic-disabled runs.

Only a successfully adopted process exposes this preparation receipt. A
discarded or failed speculative attempt is closed and drained before the
ordinary cold path; its early initialization is available only in the
existing bootstrap OTel spans when those spans are sampled and exported.
The formal stage does not include that discarded attempt, assign it zero
time, or claim full coverage or a performance saving. The accepted bootstrap
trace context and its run reference can correlate the owned attempt with
`daemon.adapter.cli_init.prewarm` and `daemon.adapter.cli_init`; a missing
span remains unavailable. The complete dispatch-to-ACK measurement still
includes any real resource contention caused by that attempt.

Local controls with fixed official 0.166.0 bytes cover anonymous
initialization, final-cwd `config/read` on a real `WorktreeManager` worktree,
and a real project-configuration counterexample that drains and returns to
cold startup. These controls send
no account, thread or turn requests. Offline protocol processes cover login
refusal, the original call order, MCP handoff and cancellation. They do not
prove live subscription adoption, provider HTTP absence, or a five-second
dispatch result; those remain real execution and measurement requirements.

## Credential preparation transport in the subsequent candidate

The candidate assembled on merged `0479675e188efeac341b207d8616c4d7b9d4ee23`
also batches the five existing credential-preparation DML statements into
one PostgreSQL simple-query message when its encoded request fits a
conservative bound below the original bound-query protocol. It still does
five writes in their original order. Larger or more expensive literal
encodings use the unchanged five bound requests; this is an optimization
limit, not a new input restriction.

The caller retains the existing transaction, locks, fresh rebind, rollback
and commit-before-bootstrap boundary. Each statement retains its READ
COMMITTED snapshot; a real two-connection barrier proves the revocation
statement sees a token committed while the prior update was waiting.
The last INSERT returns the actual `clock_timestamp()` only after that
insertion. A single message shares `statement_timestamp()`; the current
DML, defaults and audited tracked migration triggers use transaction
`now()` and final `clock_timestamp()`, not that message timestamp.

The measured ordinary preparation segment sends 228 fewer PostgreSQL
protocol bytes and transfers 322 fewer bytes in total. It does not remove
SQL work or include TCP/TLS/startup costs. Early failures may pre-send later
statement text, but no later DML run after the first error and the original
outer transaction rolls back. The bounded extra-text ledger is retained.

The [candidate evidence index](../research/2026-11-07-codex-initialize-five-write-candidate.json)
pins the inherited Codex and database proofs separately from the new
composition checks. These are local results, not live subscription
adoption or a new five-second production result. Neither this transport
change nor the account-free Codex process authorizes execution or changes
the normal HOME/worktree. No saving is booked against the separate
ready-pool design, whose complete database budget is still unproven.
