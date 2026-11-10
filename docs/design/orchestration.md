# Orchestration: models, Agents, machines, scheduling, billing

- **Status:** this is the source of truth for these topics from 2026-10-31
  ([decision](decisions/2026-10-31-2300-orchestration-spec.md)). When another
  document or code comment disagrees, follow the source order in
  [the design entry point](README.md). Alex's later recorded decisions win. The execution and credential sections incorporate Alex's
  [2026-11-06 machine-authority decision](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)
  from #1505 and the separate
  [credential-exposure boundary](decisions/2026-11-08-0240-credential-exposure-boundary.md).
  `decisions.md` rows stay as frozen history.
- **Built on:** Alex's rules of 2026-10-31 and his answers to the open
  questions, both relayed by the coordinator. Also
  [personal vs workspace](decisions/2026-10-31-2130-personal-vs-workspace.md)
  and [bots reply on Mikka 默认](decisions/2026-10-31-2110-bots-reply-on-mikka-cloud.md).
- **Scope:** the simplest system consistent with those rules. Where today's
  code differs,
  [the conflict table](research/2026-10-31-orchestration-conflicts.md) names
  the fix and its owner.

## 1. Concepts and names

| Word | What it is |
| --- | --- |
| **Account** | A person. Owns their sign-in, devices, app connections, cards, credits they verified, model credentials and E2B key. |
| **Personal workspace** | One per account, with exactly one member. Every account has one. Only that person's bots, chats, tasks and threads; personal billing; no team settings ([2310](decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md)). |
| **Team workspace** | Several members, with the team's members, policies, shared credits and payment method. Secrets belong to every workspace, personal or team ([0231](decisions/2026-11-02-0231-workspace-is-the-tenant.md)). It has no E2B key of its own. Nothing moves between it and a personal workspace; a personal workspace is never upgraded into one. |
| **Bot** | Lives in one workspace and has one owner. Runs on Mikka's own AI SDK on Vercel; when it has work to do, it sends a thread through the daemon to Claude Code or Codex (R-05). |
| **Thread** | The work a bot dispatched (`agent_runs`). Each turn of it is a **run**. |
| **Agent** | The coding worker that runs a thread: Claude Code or Codex. Code may say `harness`; the UI says Agent (R-43). |
| **Model credential** | A personal Claude Code/Codex subscription, a personal API key, or an Organization API key/gateway/custom endpoint. Subscription credentials remain account-owned. Model and credential are frozen at admission. |
| **Share** | An explicit resource ACL for content. It grants no model, device, personal memory, Secret or payment authority. Personal API key grants remain separate; personal subscriptions cannot enter a member pool ([0017](decisions/2026-11-10-0017-collaboration-governance.md)). |
| **Mikka 默认** | The hosted model, paid from the workspace's credits. It is a **model**, never a machine. |
| **Machine (电脑)** | Where an Agent runs: **Mikka Cloud** (a sandbox on the run owner's own E2B key) or a **device** (a personal computer running the desktop app, or a server running the daemon). Both are **runners** with one contract (§3). |
| **Mikka Cloud** | The cloud machine. It is a **machine**, never a model. Mikka hosts no sandbox of its own. |
| **Environment** | Where the task executes. Its own cloud VM can be retained across authorized attempts; local runs keep their task worktree (§5). |
| **Lease** | A machine's time-limited claim on a run, renewed by heartbeat (ADR 0012). |

Never write 「Mikka Cloud」 for the hosted model, and never write
「Mikka 默认」 for the machine.

## 2. Model resolution

A run's model and credential are decided when the run is created and frozen
for that run. Three things are decided independently: the model (this
section), the machine (§4) and concurrency (§5).

```mermaid
flowchart TD
  start([New run: bot B, owner O, workspace W]) --> own{One of O's credentials<br/>valid, and allowed in W?}
  own -- yes --> mine[Use O's credential]
  own -- no --> share{Another member's credential<br/>shared in W with 分享给团队成员?<br/>Claude first}
  share -- yes --> other[Use that share]
  share -- no --> hosted[Mikka 默认<br/>W's credits]
  mine --> freeze[[Frozen for the whole run]]
  other --> freeze
  hosted --> freeze
```

1. **The bot owner's own credential**, when it is valid (connected, not
   revoked or paused, quota left). It is allowed in every workspace the owner
   belongs to, with no switch and no admin limit ([2026-11-01-2240-own-credentials-always-usable](decisions/2026-11-01-2240-own-credentials-always-usable.md)). If several qualify, the bot's saved choice wins;
   after that a subscription comes before an API key, and Claude comes before
   ChatGPT/Codex.
2. **Otherwise another member's credential** shared in this workspace with
   「分享给团队成员」 ticked, Claude first.
3. **Otherwise Mikka 默认**, through the usual hosted admission (§7).

Rules that hold everywhere:

- Never refuse with 「未连接账号」 or `binding_required`. A person with no
  credential gets Mikka 默认.
- **No switch mid-run.** A run frozen on a credential that disappears stops,
  with the subscription line and 重试. A credential disappears when it is
  disconnected, revoked, paused, its share is withdrawn (for other members'
  bots), its owner leaves, or the admin turns 「分享给团队成员」 off there.
- **Quota exhausted.** The run that hit the limit stops; it never switches.
  - When 「订阅额度用完后，自动改用 API Key」 is on (the default) and the owner has
    a compatible API key for the same frozen model, the next run uses that API key. The chat says so
    in one line before the reply: 「Claude Max 额度用完，已改用 Claude API Key
    继续（按 token 计费）· 改回」; 改回 opens the model picker. Before sending,
    the composer names the used-up subscription and the key the next message
    moves to, or when the quota resets.
  - When nothing is left, the stopped run opens a popup. The person picks the
    model or credential themselves, and 重试 runs the turn on that choice.
    重试 never re-resolves on its own.
- **Allowance observation.** Unknown, stale or scope-ambiguous quota is 待检查,
  not available or exhausted. Dispatch refreshes it without requiring a visit
  to Settings. A failed check offers retry and never silently moves to a paid
  API key. Model-specific windows affect only the requested model.
- Conversation compaction uses the same frozen model and credential as the
  turn.
- This order serves bot chats. A thread uses the person's 优先使用的模型,
  with task-difficulty routing when enabled (§4,
  [1400](decisions/2026-11-02-1400-model-order-dispatch.md)). The bot itself
  runs on Mikka's own AI SDK on Vercel; a thread goes through the daemon to
  the entry's Agent (§3).

The current label is **优先使用的模型** (Preferred models). This is a
priority list, not an authorization whitelist: an explicitly requested model
may still use its authorized credential under decision 1400. The selected
thread model and credential take precedence over the bot's chat preference.
The chooser and dispatch use the same credential and machine availability.

Settings keeps account credentials and the person's defaults in the current
workspace under separate headings. Bot chat choice belongs to that bot.
[The settings flow](subscription-execution-settings.md) records these scopes
and the recovery destinations.

## 3. Agents and runners

**Model → Agent.** Each entry of 优先使用的模型 names its Agent: a
subscription model runs on the Agent of its account (Claude → Claude Code,
ChatGPT → Codex); an API key's model runs on each Agent a protocol of the key
can talk to (OpenAI → Codex, Anthropic → Claude Code). A preset provider
speaks the protocols of its official API, so a DeepSeek or Kimi key runs on
both Agents and its models are entries on each; a custom provider speaks the
one protocol the person picked. Nothing picks an Agent from a model's name
([1400](decisions/2026-11-02-1400-model-order-dispatch.md),
[1620](decisions/2026-11-02-1620-preset-keys-speak-both-protocols.md)).

「Bot 本身走我们自己的 AI SDK，跑在 Vercel 上。Bot 需要干活时，通过 daemon 把任务派给
Claude Code 或 Codex。」 (Alex, R-05)

**A user's computer or server is a runner, just like E2B.** Each runner
receives the task's resolved authority, the selected native CLI/GitHub
credentials, and scoped third-party API capabilities during preparation;
it must not automatically inherit all user/workspace/repository Secrets.
The [credential exposure decision](decisions/2026-11-08-0240-credential-exposure-boundary.md)
specifies the boundary. `lib/secrets/runtime.ts` separates ordinary env and
explicit direct exposure from protected HTTP capabilities, and the claim route
seals the latter for a supported runner. Deployed protection is established
by the decision's runtime canaries and acceptance evidence. The machine executes the assignment directly; lifecycle messages report progress
and deliver stops, without a permission round trip before each tool or model call
([1800](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md)).

| | Mikka Cloud (E2B) | The person's computer or server |
| --- | --- | --- |
| Environment | One VM per task, using a versioned additive derivative of official `claude`, `codex` or `desktop`; normal HOME, environment and Git repository | The daemon's worktree, preserving the person's repository and unrelated files |
| Agents | The template's original official CLI; a missing CLI may be added privately under `/opt/mikka` | The daemon's managed copies in its private installation directory |
| Execution boundary | The task's VM; no extra container, shadow repository or isolated HOME inside it | The task's worktree and process group; no extra sandbox or per-call remote authorization |

- **Additive official templates.** Install Mikka's Node, worker, dependencies
  and `gh` under `/opt/mikka` before task dispatch. Never delete or overwrite
  original official files. CI checks file conservation and real official
  Claude Code and Codex subscription execution on the exact candidate before
  publication; retain the last valid release for rollback
  ([1430](decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)).
- **Direct execution.** No run uses Docker, `sandbox-runtime` or the CLI's own
  sandbox. Cloud Agents use their machine's ordinary HOME, environment,
  credential stores and real `.git`; verification uses that same repository.
  Prepare shallow or partial repository clones in parallel with machine
  startup. Local worktree safeguards protect the person's unrelated work.
- **Daemon-managed local Agents.** The local daemon installs and updates its
  managed copies without replacing the person's existing executables. Any
  local configuration separation must preserve actual concurrent work or the
  person's files; it must not recreate the superseded cloud credential proxy.
- **Device capability check.** A device reports its OS, architecture, free
  disk, available Agent installations and its 参与调度 switch (§4). Model
  slots come from the actual Agent installed on that runner. A failed cloud
  boot self-check marks the runner unhealthy so its runs can be placed again.
- **Tools and providers.** Claude Code uses `bypassPermissions`; Codex uses
  approvals `never`. Only the real selected provider credential goes to the CLI:
  Claude Code talks to Anthropic and Codex to OpenAI directly. No placeholder,
  provider proxy or extra permission-preflight request is inserted before a
  call. Connected apps still make their normal authenticated operation through
  Mikka's MCP entry; that operation does not acquire another permission gate
  first. Third-party API Secrets use the separate [non-readable capability
  boundary](decisions/2026-11-08-0240-credential-exposure-boundary.md) where
  supported, without adding a Mikka control-plane authorization round trip
  to each tool call. Revocation pushes a stop to the task or reclaims its VM (§6).

## 4. Machine selection and fallback

Mikka hosts no sandboxes and offers no free cloud trial. A run's machine is
always the run owner's own: Mikka Cloud on **their** E2B key, or one of
**their** devices. An E2B key is personal and is never shared, because a
sandbox carries its owner's credentials and app access. A member never runs
on another member's E2B. In a team, each member brings their own key.

**Scheduling.** Each device has one switch, 参与调度 (Settings › 设备). Off:
Mikka never sends that device a run. Every online device that has a model's
Agent installed and, for a subscription model, can take a subscription run
(its daemon reports `subscriptionBroker`) joins the pool for it; its CLI need
not report the model ([1400](decisions/2026-11-02-1400-model-order-dispatch.md),
[1500](decisions/2026-11-02-1500-subscription-models-need-no-device-report.md)).

**Placing a new run** (decision
[1400](decisions/2026-11-02-1400-model-order-dispatch.md)):

1. A machine the run asks for is used as asked: a thread continuing in its
   environment, a device-only source event, or a device the person picked.
2. Otherwise the thread's own model, when the person picked one, then
   优先使用的模型. With 按任务难度自动选模型 on (the default), the host
   filters usable credentials, quota and machines before the Decision API
   chooses an enumerated model and supported reasoning effort. An explicit
   model or an Agent 配置 with a fixed model wins; a selected configuration
   that inherits the list uses routing only after the configuration is chosen.
   A low-confidence, invalid or unavailable decision preserves the existing
   list and placement order. Turning the setting off also preserves that order.
   运行位置 decides where, trying places in order and moving on only when
   no allowed model runs in the one before
   ([2330](decisions/2026-11-02-2330-cloud-first-dispatch.md)): 云端 (the
   default) the owner's own E2B cloud, then a server, then a computer; 本地 a
   server, then a computer. Among the devices with 参与调度 on that can run
   the entry, the one with the fewest unfinished runs goes first, then the one
   that joined first ([1530](decisions/2026-11-02-1530-local-server-first.md)).
   A cloud that fails to start the run hands it to a server, then a computer.
   The 运行位置 line in 模型与订阅 writes the order and names where a run
   goes now (会先用 云端 / <设备名>).
3. Otherwise 立即警告: no run is created and the bot at once shows the action
   card 「没有能跑这个任务的模型」 with the reason (no allowed model, no
   device can run any and 云端 has no E2B key, every model unavailable now) and
   rows that fix it: 打开模型与订阅, 连接电脑, 填入 E2B Key. Answering a row makes
   the bot dispatch again.

**Task difficulty (#1329).** Model tiers are metadata for authorized candidates,
never a catalogue: unknown models count as `standard`. The untouched default
list retains its existing leading entries and, while routing is on, includes
the other reported models from those same credentials on the preferred Agent.
It does not silently add a different paid key. A customized list is never
expanded. The run freezes difficulty, selected model, supported effort and a
localized reason code; execution details read that snapshot. Existing failure
and review-repair paths can move an automatically routed run to the next
available tier, without a second retry loop or overriding a fixed choice.
Terminal outcomes enter the existing `factory_events` ledger, scoped to that
owner and task. See [the feature spec](model-difficulty-routing.md).

**Runtime provider failure (#1225).** A thread dispatched from 优先使用的模型
can discover an empty balance, refused credentials or a provider outage only
after a real model request; a successful model-list request does not prove it
can run. That run ends with its original model frozen. The host creates a new
run from the latest allowed preferences, excluding entries already tried for
this task and rechecking credential and machine authority. An explicitly
selected model stays selected and gets the unavailable card. Older quota-only
runs keep the quota recovery in §2.

The sanitized failure in the run report also informs the chooser and later
tasks, scoped to the requester, workspace and frozen credential. Only an
explicit provider-failure stop without a stop request is failure evidence:

- Balance and authentication failures block that credential until the person
  refreshes or replaces the API key, reconnects the subscription with a new
  revision, or a later run succeeds on the credential.
- Temporary provider failures block only that credential's Agent/model entry
  for two minutes; a later success on the same entry clears it sooner. A late
  older completion cannot undo recovery. Missing authority and paused or
  disconnected credentials always take precedence.

The open thread names the failed model and reason, then 「已改用」 and the
replacement only after the host commits the continuation. Pending recovery
waits for the thread/run live updates without displaying an unconfirmed
switch; cancellation or an obsolete recovery does not claim that no model is available. If no entry can run,
the existing 「没有能跑这个任务的模型」 card lists the reasons and opens 模型与订阅.
Independent review, verification and monitoring runs remain independent: their
switch line requires the host adoption receipt, matching definition and both
attempts on the same owned task. This read-only association does not extend
the conversation's send or stop chain.

**When a machine goes away during a thread:**

- **The E2B sandbox is gone:** start a new one from the template and continue
  the thread from its branch.
- **A server goes offline:**
  1. Move the run to E2B, when the owner has a key.
  2. Otherwise move it to the owner's computer that has 参与调度 on.
  3. Otherwise end the run and 立即警告 with the same action card.
- **A personal computer goes offline:** apply the same three steps.

This replaces the old 「设备离线时」 setting.

A device runs only its owner's work. A team admin's computer policy governs
only sharing with others and the workspace's own resources; it never stops a
member running their own bots on their own device
([2240](decisions/2026-11-01-2240-own-credentials-always-usable.md), which
replaces the 「个人设备」 switch that left members' devices out). The workspace computer policy governs Agent computer operations; it does
not block a person viewing or taking over their own Bot's desktop
([1232](decisions/2026-11-02-1232-computer-policy-binds-agents-not-people.md)).

## 5. Scheduling and concurrency

The server admits the run and freezes its model, credential, machine and
payer. During machine preparation or the initial claim it delivers that
assignment and the credentials the task needs. The runner executes directly,
renews its scheduling lease through the existing heartbeat, and reports
completion. A persisted stop is delivered through the control channel; cloud
reclamation is also available when the task must end.

- **One cloud VM per task**, retained across its authorized turns and compatible
  attempts. The
  owner-bound cloud VM may pause with its ordinary private runtime state;
  the local worktree stays. Neither is given to another task or owner. A
  reusable template contains software only. The disposable VM is reclaimed
  when the task ends; there is no mandatory credential wipe and re-injection
  at every turn merely to implement the former proxy policy.
- **Concurrency.** Threads run in parallel. The runs of one thread run one at
  a time. There are no Mikka machine caps: the owner's own E2B account sets
  the limit.
- **Leases.** A claimed run holds a lease that the heartbeat renews. When a
  lease runs out because the machine is gone, the run is placed again by §4,
  keeping its frozen model and credential.
- **No machine.** A run is created only once a machine is chosen; with none,
  the bot warns at once with the action card (§4).
- **Quota exhausted.** For a credential, see §2. For Mikka 默认, the hosted
  refusal line appears with 验证银行卡 / 充值 and 重试. Admission checks only
  that the balance is positive, then charges actual use afterwards.

### Task VM lifecycle (#1593)

Authorized task dispatch creates or resumes the task's own VM. Reading a page,
typing, inspecting artifacts and receiving a heartbeat do not authorize a wake.
Each `thread_machines` row stores an epoch, a lifecycle deadline and its pending
operation. The existing deployment-owned run-recovery timer follows that row;
an individual Workflow ending, being cancelled or losing its response does not
remove this responsibility. Its slow recovery sweep recovers lost wakeups.

Execution leases, estimated running compute, monitor duration and paused data
retention are separate clocks. The monitor's 12-hour limit performs a final
state read and hands responsibility to the recovery owner. A run's 12-hour
compute budget requests a stop; paused time does not consume that budget.
This is a budget for the admitted run, not the lifetime of the task's VM. A
new authorized continuation run receives its own budget while the previous
run retains its compute record. Heartbeat renewal and Workflow replay do not
reset a run's budget, and a stopped run cannot silently restart itself.
Missing leases use the existing lease recovery, and the Factory watchdog
continues to distinguish progress from a healthy heartbeat.

| State or event | Action and default deadline |
| --- | --- |
| Claimed execution, including an offline person's long command | Keep the running provider VM alive under its execution lease and budget. |
| Created/resumed but unclaimed, with no live bootstrap lease | Pause after two minutes. |
| Native `ask_human`, successful, failed or stopped completion | Wait for final worker evidence, then pause; revoke the device token and retain the filesystem/native session. |
| Quota wait after confirmed native exit | Pause without cancelling the waiting run; its existing quota/recovery event authorizes the next dispatch. |
| Adjacent admitted Factory stage, compatible repository and harness | Transfer the same running VM and rotate authority within a 45-second window. An incompatible stage parks the previous VM. |
| Stop or revoked execution that does not acknowledge within 30 seconds | Freeze the full VM state and revoke runtime tokens; keep the sole filesystem, and do not invent a native completion receipt. Automatic adoption stays blocked until native exit is confirmed. |
| Closed task | Pause first; after one hour, retire only with the final exited/ready receipt and its exact uploaded checkpoint. Recheck task closure and epoch under locks. |
| Unfinished task paused for seven days | Review the retained evidence. A Git checkpoint alone does not archive native CLI sessions: keep the VM paused with `native_archive_unverified` until a verified recovery archive exists. Never destroy the only copy by age alone. |

The daemon closes the native session, finishes publications/capture uploads and
uploads its final checkpoint before completing a run. Its `safePoint` report is
constructed by the supervisor, not accepted from model output. A failed upload,
forced detach or unconfirmed native exit cannot authorize retirement.

Provider pause and kill intents commit before the external call. Their bounded
retries remain due after a crash or refused response, and a confirmed provider
result is reconciled with read-only `getInfo`. Maintenance never uses `connect`,
which can resume a paused VM. A lost creation response is recovered through a
bounded, read-only lookup of its exact owner/workspace/run/operation metadata.
The recovered reference commits before pause or kill. An ambiguous or absent
allocation remains an explicit unresolved intent. Duplicate callbacks share a persisted claim and
deadline; run/task ownership, sandbox ID and epoch fence every destructive
operation. A kill intent with an uncleared provider reference is shown as an
error requiring reconciliation, not as an already retired machine.

Lifecycle events contain fixed reason codes, stable identity hashes, epoch,
deadline, provider outcome and database-estimated compute. Raw provider output,
credentials, prompts and native session contents are excluded. The separate
anonymous warm pool and its retention remain independent of task ownership.

## 6. Credentials lifecycle

[Issue #1849](https://github.com/alexj11324/Mikka/issues/1849) and
[decision 0017](decisions/2026-11-10-0017-collaboration-governance.md) amend the
sharing rules. A shared Thread retains its Owner and records each message's
actual Actor. A collaborator cannot borrow an Owner's personal subscription or
local device. Any allowed owner-funded cloud turn requires a separate, bounded,
revocable authorization; the Run freezes the Actor, Thread Owner, executor,
credential owner, model payer and compute payer. The admission and renewal
paths revalidate that authority without adding a proxy before native model or
tool calls. The implementation and acceptance status is tracked per PR in
[collaboration governance](collaboration-governance.md).

This section follows Alex's [#1505 decision of 2026-11-06](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md).
One task, one VM is the cloud execution boundary. The former placeholder,
provider-forwarding proxy, isolated cloud HOME and repeated remote permission
checks are superseded.

1. **Reusable images and account storage.** Public templates and other
   reusable images contain software only, with no login, token, device identity
   or workspace data. Subscription and API credentials remain associated with
   their real account; app connections and saved logins keep their account
   ownership. The E2B account pays for and owns the task's cloud resources.
2. **Preparation and admission.** Resolve the requester, selected model,
   credential owner and any explicit share, destination and payer once when
   admitting or explicitly moving the work. Deliver only the selected native
   CLI subscription login or model key and the authorized GitHub credential
   during preparation, or once on the first request that needs them. Use the
   CLI's normal credential mechanism. Other sensitive user/workspace/repository
   API Secrets use scoped protected capabilities where supported, with an
   explicit direct-exposure mode for compatible workloads. Ordinary config
   env values remain env. `lib/secrets/runtime.ts`, `delivery.ts` and the
   run claim route implement this split; runtime acceptance must verify the
   protected path on its actual runner. Never log credentials or bake them
   into a reusable image.
3. **Execution and renewal.** The assigned machine has the authority to run
   the task. Official CLIs call their providers directly; no Mikka model proxy
   or extra server authorization request precedes each model or tool call.
   Refresh naturally expiring provider tokens in the background before expiry
   and update the live CLI's normal credential mechanism. A healthy Claude Code
   run does not end merely because an old access token expires. Routine
   heartbeat and app operations remain their own requests, not per-call
   authorization preflights.
4. **Revocation and completion.** Removing a share, revoking a connection or
   stopping work persists and pushes a stop to the runner, or stops/reclaims
   its cloud VM. A local stop ends only that task's processes. Private state
   can remain with the same paused task; it is never published as a reusable
   snapshot or reassigned to another task. Reclaim the disposable VM at task
   completion, and preserve local files unrelated to that task.

When a member leaves a team, their shares, card designation and credit
shares leave that workspace at once, and their bots there are paused (暂停).
An admin may take a bot over. It then runs on the admin's resources or the
workspace's.

### Execution identity and provenance (#1163)

The host freezes the requester, executing Bot owner, execution principal,
selected model and device resource references, billing accounts and output owner
with each new run. A group reporter Bot is separately recorded by the group's
host binding; choosing a reporter never transfers that Bot owner's accounts or
computer. Personal app connections remain the execution requester's connections.

Admission and an explicit device handoff resolve current ownership, membership
and sharing authority before issuing the machine's assignment. A shared
subscription or API key requires both members to be active, the explicit share
and the applicable workspace policy at admission. A later revocation delivers a
stop rather than imposing a fresh permission round trip on each provider or tool
call. The selected resource and payer cannot change implicitly on retry.
A host-authorized device handoff checks the new device's owner and preserves
the requester's identity; a consented quota fallback records the newly selected
API key and its actual owner. Cloud continuation freezes its parent placement
before rebinding to the new thread machine.

Artifact versions retain this provenance without changing the artifact's owner
or sharing rules. Owner-only run details and account usage show the frozen
attribution. Historical rows without a snapshot remain unattributed; current Bot
ownership is never used to reconstruct who paid for a historical run.

## 7. Billing

Mikka-hosted calls use the applicable workspace's credits. Personal subscriptions,
API keys and E2B use the account shown below. External provider amounts remain
unknown unless the provider supplies a receipt; 0 Mikka credits is not a zero
external bill.

| Work | Who pays |
| --- | --- |
| A run on a subscription | The credential owner's own plan quota. 0 credits. |
| A run on an API key or a custom provider | The key owner, billed by their provider. 0 credits. |
| A run on Mikka 默认 | That workspace's credits. |
| Mikka Cloud time | The run owner's own E2B account, billed by E2B. Mikka charges nothing. |
| A device | Nobody. |
| Coordinator, memory extraction and other work with no workspace of its own | The personal workspace, never 「the oldest workspace」. |

- **Verification is per person.** A person verifies a card once, on Stripe's
  page. The one-off USD 1 credit goes to the verifier's personal workspace,
  once per card.
- **The payment method is per workspace.** Each workspace designates the card
  its credits are bought with.
- **Credits can be shared.** As with a card designation, a person may opt in
  to share their credits with a team workspace. Both go away when that member
  leaves.
- **Hosted admission** requires a verified person and a positive balance in
  the workspace.

## 8. MVP vs later

| MVP | Later |
| --- | --- |
| A personal workspace for everyone; team workspaces beside it | — |
| Account-level subscriptions, API keys and custom providers on 「模型与订阅」; own credentials usable in every workspace with no switch; 「分享给团队成员」, which an admin can switch off | Per-member spend caps |
| Model order of §2; Mikka 默认 when there is nothing else; no mid-run switch; 「订阅额度用完后，自动改用 API Key」; a popup when nothing is left | — |
| Model → Agent mapping with a per-model override | — |
| Mikka Cloud on each person's own E2B key, with no Mikka caps | — |
| Personal computers and daemon servers as runners with the same contract: daemon-managed Agents, an ordinary worktree, direct provider credentials and no sandbox; cloud machines on additive official E2B templates | — |
| A device capability check and 参与调度 instead of Agent detection and 「设备离线时」; 优先使用的模型 in order instead of label rules and 任务默认 | — |
| 立即警告 (the action card) when there is no machine; the offline flow of §4 | — |
| One cloud VM per task, retained across authorized attempts; leases and heartbeats; selected credentials prepared once, background renewal and pushed stops | — |
| Card verification per person; credit and card shares per workspace | — |
| No Mikka-hosted sandboxes and no free cloud trial | (not planned) |
