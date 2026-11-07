# One task, one machine; execution authority stays on the machine

- Date: 2026-11-06 18:00 UTC
- Source: Alex's [decision on #1505](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691833153) and [the explicit replacement of the old credential rules](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691871552).
- Rule: Cloud execution, local daemon execution, credential delivery and startup acceptance.
- Replaces: the extra runtime isolation, placeholder/provider proxy, per-call remote authorization and credential cleanup requirements in [orchestration §§3, 5–6](../orchestration.md); the corresponding parts of [1312](2026-11-01-1312-cloud-runs-without-docker.md), [2335](2026-11-01-2335-e2b-official-templates.md), [2225](2026-10-31-2225-bindings-belong-to-the-person.md) and [1600](2026-11-02-1600-agents-use-own-github-credential.md). Account ownership, the selected model, billing attribution and workspace sharing rules remain in force.

Alex's words, as recorded in the issue:

> 「本身我们现在就是一个任务一台机器，你的这个安全隔离做法就已经是错误的了，你还在错上加错。本身这个东西一个任务一台机器就已经非常安全了。」

> 「我要求就是说权限完全下放到机器，不应该再这样做，就像服务器确认有没有权限了……这样已经非常严重的干扰到我们的正常工作流了，你应该撤销掉。……绝对不允许出现就是说你为了安全降低效率。」

> 「你除了 CC 和 Codex 本身的启动之外，你其他的凭证之类的……你通通应该提前给他。隔离环境甚至都不需要，因为我们现在已经是一台机器一个任务了。」

The second comment explicitly replaces the older claim that a subscription
never leaves the server and that the Agent must hold a placeholder while
Mikka checks and forwards every model request. It also requires before/after
per-call timing evidence before removing that proxy path.

## Cloud execution

One thread task owns one E2B VM. That VM is the boundary between tasks; no
other task or owner uses it. Claude Code and Codex run directly as the
machine's normal user, with its normal HOME, environment and Git repository.
Do not add a container, a second sandbox, a shadow `.git`, an isolated HOME,
an environment allowlist or an isolated GitHub configuration inside it.
Verification commands use the same repository too. A read-only task remains
an instruction to the Agent, not a reason to manufacture another repository.

Prepare the task's real subscription login, GitHub credential and selected
model key while preparing the machine, or once on the first request that
needs them. Claude Code connects directly to Anthropic and Codex directly
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
Deliver task credentials only after creating the owner-bound VM. Its normal
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
