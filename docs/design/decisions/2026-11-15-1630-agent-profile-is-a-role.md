# Agent 配置只是一个角色；模型按一句话的规则选

- Date: 2026-11-15
- Source: Alex, 2026-11-15, comparing Mikka with Capy and Warp: 「这 agent profile 是从 warp factory 继承过来的一个概念，但说实话，我感觉我们把它过度复杂化了，导致确实……非常不清晰」; then 「我不想要太复杂，太复杂用户看不懂」.
- Status: direction decided; not implemented.
- Rule: —
- Replaces:
  - in [factory-agent-profiles.md](../factory-agent-profiles.md): automatic Profile selection by the Decision API, the selectable built-in Default and its `default` reference, the `roles` capability tags, and the Profile's separate harness and effort fields;
  - [2026-11-06-1640](2026-11-06-1640-model-routing-judges-tier-and-effort.md): automatic model routing is removed;
  - in [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md): "the host chooses the model", which is now the rule below.

## 用户要懂的只有三句话

1. **Agent 配置**是一个角色：名字、指令、Skills，可以指定一个模型。不选也行。
2. **模型**：任务指定了就用它；否则用 Agent 配置的模型；再否则用「优先使用的模型」里第一个能用的。
3. **机器**：任务指定了就用它；否则按「运行位置」。

界面、文档和 Coordinator 的说明都只讲这三句。没法用这三句解释的行为不做。

## 具体

- Agent 配置的字段只剩：名字、说明、指令、Skills、模型（可不填）。
- 谁选 Agent 配置：人在新建任务里选；人没选时 Coordinator 可以按名字选一个，线程上显示是谁选的。不再有自动判断。
- 分诊、方案、实现、审阅这些阶段用 Mikka 自带的说明，不需要用户配置任何东西。
- 指定的模型跑不了，就告诉用户为什么，不偷偷换。没指定、按顺序换到下一个模型时，线程上写一行「改用 X：原因」。
- 去掉自动按难度选模型。

## 不变

- Skill 的锁定、校验和加载记录。
- 每次运行记下用了哪个配置、哪个模型、哪台机器，线程里能看到；历史运行不改写。
- 授权、额度检查。

## 迁移

- 已有配置的 harness、模型、推理强度合并成一个模型；能力标签丢弃。
- 历史运行里「自动选择」的记录照原样显示。

## 实现时要动的地方

- `lib/factory/agent-profile-decision.ts`、`lib/factory/automatic-dispatch.ts`：去掉自动选择。
- `lib/factory/agent-profile-definition.ts`、`agent-profile-store.ts`、`agent-profile-templates.ts`：字段和迁移。
- `lib/model-routing*.ts`：删除；`lib/model-order-plan.ts`：上面第 2 句的顺序。
- `workflows/coordinator/tools.ts`：`profileId`、`model` 的说明改成上面三句。
- `components/coordinator/task-profile-picker.tsx`、`components/settings/factory-profiles-settings.tsx`、`components/workspace/thread-execution-identity.tsx`，以及 hosted UI 的 `slots/new-task.tsx`、`lib/models/profiles.tsx`。
- [factory-agent-profiles.md](../factory-agent-profiles.md)：按本决定重写。

## 参考

- Warp 的 Agent Profile（[docs](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)）是模型加权限，不是角色；角色是 Factory agent（[docs](https://docs.warp.dev/factories/factory-agents/)），由 foreman 按名字挑，没写的设置继承默认值。
- Capy 的 Captain（[docs](https://docs.capy.ai/captains)）：船员默认用 Captain 的模型，例外由 Captain 自己决定；船员在哪跑是一个设置。
