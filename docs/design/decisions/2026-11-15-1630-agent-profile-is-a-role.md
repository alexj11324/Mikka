# Agent 配置只管角色；模型和机器各走一条继承链

- Date: 2026-11-15
- Source: Alex, 2026-11-15, in a cloud session comparing Mikka with Capy and Warp: 「这 agent profile 是从 warp factory 继承过来的一个概念，但说实话，我感觉我们把它过度复杂化了，导致确实……非常不清晰」, then 「可以」 on the proposal below, and 「你最好也看一看那个原版的 profile 长什么样子」.
- Status: direction decided; not implemented.
- Rule: —
- Replaces:
  - in [factory-agent-profiles.md](../factory-agent-profiles.md): the automatic Profile Decision (`capability_fit` / `stage_fit` / `none`, the 0.55 threshold, the 201-choice catalogue, `currentWork`), the built-in Default as a selectable object with the closed `default` reference, and the `roles` capability tags;
  - in [2026-11-06-1640](2026-11-06-1640-model-routing-judges-tier-and-effort.md): routing as a layer that runs on every dispatch. The judge, its two `score` questions and its calibration stay; they now run only when 自动 is chosen;
  - in [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md): "the host chooses the model", which now means the inheritance chain below.

## 原版是什么

Warp 有两个不同的东西，我们把它们合成了一个，又加了一层自动选择。

- **Agent Profile**（Warp app 和 Oz CLI，[docs](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)）：一组运行设置，不是角色。内容是名字、base model（可另设 planning model）、各类动作的自主程度（Agent decides / Always ask / Always allow / Never）、命令白名单和黑名单、MCP 白名单和黑名单、目录范围。每人有一个可编辑的 Default，新建的 Profile 从它复制。运行时用 `--profile <id>` 指定。
- **Factory agent**（[docs](https://docs.warp.dev/factories/factory-agents/)，定义在 `agents/<name>/agent.md`）：这才是角色。frontmatter 有 `description`、`agentType`（FOREMAN / TRIAGE / SPEC / IMPLEMENT / REVIEW / VERIFY / CUSTOM）、`spawnableBy`，以及覆盖 `agentDefaults` 的 `model` 或 `harness`、`runner`、`environmentId`、`secrets`、`mcpServers`；正文是 prompt，`skills/` 放该角色的 Skill。
- **谁来选：** foreman 在自己的 `run_agents` 工具调用里，从可用 agent 列表中按 UID 选一个。没有独立的判断服务。没写覆盖的字段都继承 `agentDefaults`。文档建议审阅用和实现不同的模型或 harness。

Capy（[Captains](https://docs.capy.ai/captains)）没有角色对象：Captain 的模型由船员继承，例外写在它 Drive 里的 `AGENTS.md`；船员在哪跑是 Captain 上的一个设置（Crew runs on），单个任务口头点名覆盖。

## 决定

派一个任务回答三个问题，每个问题只由一个东西回答，规则各一句话。

### 1. 什么角色：Agent 配置

Agent 配置是一个角色，对应 Warp 的 factory agent，不对应 Warp 的 Agent Profile。

- **保留：** 名字、说明、私有指令、Skills（来源、锁定版本、摘要校验、`load_skill` 回执都不变）。
- **新增「用于」：** 分诊、方案、实现、审阅之一，或不填。和 Warp 的 `agentType` 一样，只是一个标签，不是能力描述。
- **去掉：** `roles` 能力标签、`harness`（跟着模型走）、单独的 `effort`（并进模型选择）。
- **可选的模型：** 填了就是继承链里的一层（见 2）；不填就继承。
- **不选就是没有角色。** 内置 Default 不再是可选的对象，`default` 引用值退役。
- **不放机器。** Warp 的 agent 可以带 runner；Mikka 的机器多是个人电脑，放进可共享的角色里会出现"角色指定了别人的电脑"，所以机器留在 3。

### 谁选角色

- 人在 新建任务 的 Agent 配置 里选。
- 人没选时，Coordinator 在派发工具调用里按名字选（`profileId`），并写一句理由，和 Warp foreman 的 `run_agents` 一样。理由显示在线程的运行身份里。人可以在对话里纠正，Coordinator 把纠正写进它的指令。
- 阶段派发（分诊、方案、实现、审阅）不再判断：取标了该阶段的配置；有多个时取最近使用的那个；一个都没有就不带角色。
- 不再调用 Decision API 选 Profile。

### 2. 用什么模型：一条继承链

任务点名的模型 > Agent 配置的模型 > 优先使用的模型里第一个现在能跑的。

- 点名的模型只试它自己，跑不了就说明原因，不换（同 [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md)）。
- Agent 配置的模型跑不了时，按优先使用的模型顺序换，并在线程里注明。
- 线程同时记录并显示"选的模型"和"实际在跑的模型"。
- 推理强度跟着模型选，没有单独的覆盖层。
- **自动：** 模型的一个取值，可以填在任务或 Agent 配置里，也可以在优先使用的模型卡片里设成默认（「按任务难度选模型」，默认关）。选了自动才跑 1640 的强度和推理强度判断；判断结果和不确定时的行为不变。

### 3. 在哪跑：默认加点名

不变：运行位置（云端或本地）是默认，任务点名机器就覆盖。补一条：派发结果和运行身份写明实际的机器和目录。Agent 配置不影响机器。

## 保持不变

- Skill 的来源、锁定、校验、`load_skill` 和回执（[2026-11-10-1700](2026-11-10-1700-agent-profile-skill-sources.md)）。
- 每次运行锁定所选配置的版本和摘要，运行身份对话框照常显示。历史运行不改写，旧的理由码照原样显示。
- 授权、额度和 claim 时的检查。
- 设置里的 Agent 配置列表和模板（调查、方案、实现、审阅）；模板改为带上「用于」。

## 迁移

- 已有配置的 harness 和模型并成新的可选模型；`effort` 并进去；`roles` 丢弃。
- 模板「调查 / 方案 / 实现 / 审阅」创建的配置，按模板补上「用于」；其他配置「用于」留空。
- 选择来源 `decision` 不再产生；`explicit` 拆成"人选的"和"Coordinator 选的"。

## 实现时要动的地方

- `lib/factory/agent-profile-decision.ts`、`lib/factory/automatic-dispatch.ts`：去掉 Profile Decision，改成阶段映射。
- `lib/factory/agent-profile-definition.ts`、`agent-profile-store.ts`、`agent-profile-templates.ts`：字段调整和迁移。
- `lib/model-routing*.ts`、`lib/model-order-plan.ts`：路由只在自动时调用；继承链。
- `workflows/coordinator/tools.ts`：`profileId` 的说明改为 Coordinator 可以按名字选并给理由。
- `components/coordinator/task-profile-picker.tsx`、`components/settings/factory-profiles-settings.tsx`、`components/workspace/thread-execution-identity.tsx`，以及 hosted UI 的 `slots/new-task.tsx`、`lib/models/profiles.tsx`。
- [factory-agent-profiles.md](../factory-agent-profiles.md)：按本决定重写，去掉上面"Replaces"列出的段落。
