# Agent 配置只有内容；模型和机器跟随主线程

- Date: 2026-11-15
- Source: Alex, 2026-11-15, after comparing Mikka with Capy and Warp: 「我感觉我们把它过度复杂化了」, 「太复杂用户看不懂」, 「capy 似乎没有这么复杂」, then: 「Agent profile 还是要有，但只需包含 skill 和 instruction，不要限制它的 device 和模型，也就是它只有内容。到时候调用时，直接调用这个 Agent profile 即可。至于模型和设备，都由主线程自己去做选择，默认跟随主线程的模型和设备。用户也可以明确进行指定」.
- Status: decided. Implemented: Agent 配置 hold content only and nothing chooses one automatically; automatic model routing is removed; a new task dispatched from a chat follows that chat's model when a thread can run it, and the thread's model row says 「跟随主线程」 (`modelDispatch.followed`); 「Mikka 默认」 is gone, so following always applies. Not yet implemented: a thread's own child tasks following its machine (a running thread has no tool to dispatch a child task yet); telling 你 from 主线程 for a named model (both arrive as the dispatch tool's `model`).
- Superseded in part by: [2026-11-17-1800](2026-11-17-1800-one-agent-per-thread.md) (a new task no longer follows the dispatching chat's model; every dispatch names its Agent, and a thread keeps it for life)
- Rule: —
- Replaces:
  - in [factory-agent-profiles.md](../factory-agent-profiles.md): the Profile's Agent/model policy, harness, reasoning effort and `roles` capability tags; automatic Profile selection by the Decision API; the built-in Default as a selectable object and its `default` reference; availability of a Profile per destination;
  - [2026-11-06-1640](2026-11-06-1640-model-routing-judges-tier-and-effort.md): automatic model routing is removed;
  - for dispatched tasks, the model and machine defaults of [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md) and [2026-11-02-2330](2026-11-02-2330-cloud-first-dispatch.md) (优先使用的模型 order and 运行位置);
  - in [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md): "the host chooses the model".

## 规则

1. **Agent 配置只有内容：** 名字、说明、指令、Skills。它不指定也不限制模型和机器。
2. **调用：** 派发任务时直接点名一个 Agent 配置，也可以不点。点名的可以是用户，也可以是主线程。
3. **模型和机器：** 用户明确指定的优先；否则由主线程决定；主线程没决定，就跟随主线程自己的模型和机器。

主线程是派发这个任务的线程：Coordinator 或 Bot 的对话，或者派发子任务的那个线程。

**机器（对齐 Capy）：** Coordinator 和 Bot 的对话自己没有机器，它们派出的任务按「运行位置」跑，相当于 Capy Captain 的 Crew runs on；只有线程派出的子任务才跟随父线程的机器，相当于 Capy 子代理共用父机器。「运行位置」保留现有的后备链：云端起不来时换服务器，再换电脑（Capy 不换，只报错；Alex，2026-11-15：「加一条后备链没有什么关系」）。

## 具体

- 用户在新建任务里可以选 Agent 配置、模型、机器；三个都可以不选。不选的模型和机器显示为「跟随主线程」。
- 主线程换模型或机器时，在派发结果里写一句理由；线程上显示实际用的 Agent 配置、模型、机器，以及是谁定的（你 / 主线程 / 跟随）。
- 指定或跟随的模型在目标机器上跑不了，就把原因告诉主线程和用户，不自动换别的模型。主线程可以另选。
- harness 跟着模型走：Claude 的模型用 Claude Code，OpenAI 的模型用 Codex。
- 没有自动判断：不再自动选 Agent 配置，也不再按难度自动选模型。

## 不变

- Skill 的来源、版本锁定、校验和 `load_skill` 记录（[2026-11-10-1700](2026-11-10-1700-agent-profile-skill-sources.md)）。
- 每次运行记下用了哪个 Agent 配置的哪个版本，历史运行不改写，旧记录照原样显示。
- 授权和额度检查。

## 迁移

- 已有 Agent 配置的模型、harness、推理强度、能力标签丢弃，只留名字、说明、指令和 Skills。
- 模板（调查、方案、实现、审阅）只保留指令和 Skills。

## 待定

- 对话用「Mikka 默认」时，线程跑不了它，任务暂时按「优先使用的模型」。模型网关的方案去掉「Mikka 默认」并让线程用 Mikka 额度跑任意模型后，跟随就总能成立；Capy 也是这样（所有模型都能用它的额度跑）。

- 跟随的模型额度用完时，Capy 换同一模型的另一个来源，不换模型；Mikka 目前只试第一个来源。来源解析由模型网关那一步负责。

## 实现时要动的地方

- `lib/factory/agent-profile-definition.ts`、`agent-profile-store.ts`、`agent-profile-templates.ts`：去掉模型类字段，迁移。
- `lib/factory/agent-profile-decision.ts`、`lib/factory/automatic-dispatch.ts`：去掉自动选择。
- `lib/model-routing*.ts`：删除；`lib/model-order-plan.ts` 和派发路径：默认取主线程的模型和机器。
- `workflows/coordinator/tools.ts`：`profileId`、`model`、机器参数的说明改成上面三条。
- `components/coordinator/task-profile-picker.tsx`、`components/settings/factory-profiles-settings.tsx`、`components/workspace/thread-execution-identity.tsx`，以及 hosted UI 的 `slots/new-task.tsx`、`lib/models/profiles.tsx`。
- [factory-agent-profiles.md](../factory-agent-profiles.md)：按本决定重写。

## 参考

- Warp 的 Factory agent（[docs](https://docs.warp.dev/factories/factory-agents/)）：角色是指令和 Skills，由 foreman 按名字调用，没写的设置继承默认值。
- Capy 的 Captain（[docs](https://docs.capy.ai/captains)）：船员默认用 Captain 的模型，例外由用户或 Captain 指定。
