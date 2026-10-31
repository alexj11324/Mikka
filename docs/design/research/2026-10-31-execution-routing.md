# Execution rules: choose the model per task, the machine per run

- **Status:** research and proposal, pending Alex's approval
- **Date:** 2026-10-31
- **Figma:** page 「执行规则 · 模型按任务、机器按需 · 待 Alex 确认（Claude ·
  2026-10-31）」 (`740:6031`) in file `zPe5LKycb2XuT1ivCLRw07`. The frames
  are not accepted until a decision lists them.
- **Why:** Alex asked how Factory and Warp decide which model runs which
  task, and pointed out that pinning each rule to one device blocks running
  the same kind of work on several devices at once.

## 1. Today

`execution_rules` (`docs/execution-rules.md`) maps a label to exactly one
`place`, which is an owned device UUID or `cloud`, plus a harness and a
model. The first matching label wins, and a default row catches the rest.

Pinning a rule to one device causes two problems:

1. That device is the only machine for the label. When it is busy or
   offline, work queues behind it (`whenDeviceOffline: wait`).
2. The rule couples three separate choices: which model, which machine, and
   how many can run at once.

## 2. Precedent

### Warp

- **Auto models.** Auto (Responsive), Auto (Cost-efficient), Auto (Genius)
  and Auto (Open-weights) pick a model for you
  ([model choice](https://docs.warp.dev/agents/inference/model-choice.md)).
- **Custom routers** (Settings › Agents › Warp Agent › Custom Routers) send
  each task to a concrete model you chose
  ([custom routers](https://docs.warp.dev/agent-platform/inference/custom-routers/)).
  - **Complexity-based:** easy, medium and hard, each with a model, plus a
    default.
  - **Rule-based:** natural-language rules, each with a model, evaluated
    「top to bottom, and the first rule that matches wins」, plus a default.
  - The model is chosen when a conversation starts and is kept for the rest
    of it; a trivial first prompt does not lock it.
  - A router can only resolve to concrete models. A model disabled for the
    organization falls back to the default.
  - Team-shared routers are Enterprise-only and admin-edited.
- **Agent Profiles** each carry a base model, which planning also uses.
- **Where it runs is a separate choice.** Each cloud agent runs inside an
  *environment*, which is a definition (repository, image, setup), not a
  machine. Oz runs many agents in parallel across machines and repositories
  ([Oz quickstart](https://docs.warp.dev/agent-platform/cloud-agents/quickstart),
  [launch](https://www.warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents)).

### Factory

- **Factory Router** (shown as Auto Model) 「evaluates the work in front of it
  and routes each task to the model with the best balance of quality,
  latency, and cost」. It sends routine steps to cheaper models instead of
  locking a session to one model. Admins allow or restrict it like any other
  model
  ([Factory Router](https://docs.factory.com/web/factory-router)). The
  inputs it routes on are not documented.
- **Custom droids** are subagents defined as Markdown files with a `model`
  field: `inherit` or a pinned model, plus `reasoningEffort`, `tools` and
  `mcpServers`.
  - The main droid delegates through the Task tool, on its own or when the
    user asks. Several Task calls run in parallel.
  - Project droids (`.factory/droids/`) override personal ones
    (`~/.factory/droids/`).
  - A pinned model that the org blocks falls back to the parent's model.

  Source: [custom droids](https://docs.factory.com/cli/configuration/custom-droids).
- **Settings:** a personal default model, plus `specModeModel` for planning.
  The org sets `allowedModelIds` / `blockedModelIds`
  ([app settings](https://docs.factory.ai/factory-app/settings.md),
  [org controls](https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control)).

### What the marketing videos show

The 「many models」 in these videos come from three mechanisms:

1. a router that picks per task, or per step in Factory's case;
2. a planning model that differs from the execution model;
3. subagents that each pin their own model.

Neither product binds a model to a machine, and neither binds an agent to
one machine.

## 3. Proposal

Three independent choices:

1. **Model, per task.**
   - A rule matches a task by label (as today) and names a harness and
     model.
   - Rules are ordered, the first match wins, and the 其他任务 row is the
     default (Warp's rule-based router).
   - Matching stays on labels the person can see, which keeps decision
     2026-10-30 (no 自动). Natural-language matching (Warp's rule
     descriptions) is open question 2.
2. **Machine, per run.** A rule's place is one of:
   - **Mikka Cloud:** each thread gets its own machine, as already designed
     (`cloud-computer-backend.md` § 2).
   - **任一在线设备:** any of my online devices with free capacity and the
     harness installed.
   - **A specific device**, only when the work needs that device's files or
     tools.
3. **Parallelism, per machine.** A 并行 section sets how many threads each
   device runs at once (each in its own worktree). Mikka Cloud is always
   one machine per thread, within the existing spend guards (decisions.md,
   2026-10-29).

A rule with **任一在线设备** removes most of `whenDeviceOffline`: the run
goes to another online device. The setting stays for rules pinned to one
device.

### Frames

| Frame | Shows |
| --- | --- |
| 1 · Bot 与 Agents：任务规则 | Ordered rules (label → model → place), with 其他任务 last, then 并行 per machine |
| 2 · 运行位置菜单 | Mikka Cloud, 任一在线设备, then each device with its online state |
| 3 · 线程列表 | One rule's threads running at once on Mikka Cloud, a MacBook and a server, each row naming place and model |

Following R-40, the frames have no helper sentences. Order is shown by the
drag handles, and status is a dot.

### Data change, if accepted

- Allow `place = 'any'` in `execution_rules` (today only a device UUID or
  `cloud`).
- Add a per-device thread limit, for example
  `devices.maxConcurrentThreads`, defaulting to 1 so behaviour does not
  change.
- Dispatch picks the first online device that has the rule's harness and is
  under its limit. Otherwise the run queues, as today.

## 4. Open questions for Alex

1. Should 任一在线设备 be the new default place for local rules, instead of
   the first online device being pinned?
2. Keep label matching only, or also allow Warp-style natural-language rule
   descriptions?
3. Should a separate planning model (Factory `specModeModel`, Warp's profile
   base model) be a row, or wait?
