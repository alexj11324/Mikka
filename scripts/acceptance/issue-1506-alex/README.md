# Issue 1506：ACME 本人隔离验收

本目录的执行对象是通过 `ACME_DEMO_EMAIL` / `ACME_DEMO_PASSWORD` 正常登录的 ACME 账号，且必须匹配 `OFtPbAHifGBAOYiek9hd3w`。正常登录、会话 cookie、RPC 编解码、NDJSON 和 Coordinator live 协议复用既有 helper。此目录作者只运行了离线夹具；没有生产或付费模型调用。

## 阶段一：准备工作区并记录 #1490 基线

入口为 `.github/workflows/issue-1506-alex.yml`。只有这个 YAML 或 `control/invocation.json` 的明确修改触发执行；实现文件的修改不会自动重新创建工作区。固定并发组防止与其他验收会话互相影响。

控制文件冻结的首轮参数是：

- 生产 SHA：`2960d783f0196fed5375593d910a43430a101747`。
- 固定 fixture key：`acme-1506-20261106`。它不会随 GitHub run ID 变化。
- 顺序：正常创建专属 team → 正常创建并选择两个独立 Bot → Haiku 首字停止一次 → Luna 首字停止一次。
- 每阶段前后都有独立公开版本读取；业务脚本内还会在发送前检查版本。版本变化使这一阶段的验收结果失败，不重发模型消息。
- 任一 baseline 失败仍保存原始脱敏观察，另一模型独立运行；最终工作流保留失败状态。

工作区名称为 `测试 Issue 1506 ACME acme-1506-20261106`，slug 为 `acceptance-1506-acme-acme-1506-20261106`。创建前按这个精确名字检查当前账号的工作区列表；创建确认丢失只再发现一次，不重复创建。创建后必须是本人唯一活跃管理员、没有邀请、没有已有 Bot 或群。通过正常 `personal-policy` action 为这个新 team 开启本人既有订阅和既有余额共享，`allowOthers=false`，没有增加余额、没有新增连接，也不调整原工作区。

两个 Bot 名字均含“测试”，与 run key 和模型 key 绑定，保存独立 UUID 和正常 model-menu option UUID：

| key | 模型 | 来源 |
| --- | --- | --- |
| `haiku` | `claude-haiku-5-5` | ACME 本人已连接 Claude |
| `luna` | `gpt-6-luna` | ACME 本人已连接 Codex |

候选来源限定为本人已经核对的两条连接。选择只调用正常 `execution-settings.chooseBotModel`；每次发送前读取当前选项，拒绝 fallback、错误所有者、错误工作区、错误 Bot 或忙碌聊天。所有 chat 调用使用 receipt 中的明确 Bot UUID，不调用 `null` Coordinator 入口。运行时是否仍使用本人订阅与指定模型，需要用对应 workflow/run 的服务端证据确认；menu guard 不会伪造运行时确认。

阶段一保留工作区和两个 Bot，不自动隐藏或删除。产物在 `issue-1506-alex-report/`：

- `workspace.json`：工作区 receipt、创建和共享结果。
- `coordinator-fixtures.json`：两个 Bot / option receipt。
- `coordinator-baseline-haiku.json`、`coordinator-baseline-luna.json`：独立观测结果。
- `phase-*.json`：每阶段前后的真实版本、是否尝试和最终状态。

同一控制文件重跑不会创建另一个名字的 team。若已完成 Bot 创建，不应再运行 workspace setup；它会因工作区不再是空 fixture 而拒绝。后续复用已保存的 receipt。若初次创建或 model-choice 确认丢失，`coordinator-fixtures.mjs resume <receipt>` 仅按 receipt 恢复，不擅自重复选择或创建。

## 后续跨轮首字和停止验收

将已验证的 fixture receipt 放入本次工作目录，并由执行者设置以下环境变量。凭据仍只由正式 OIDC 步骤放入 runner 环境，不放入命令行或 JSON。

```bash
export MIKKA_ACCEPTANCE_SHA=<当前要验收的完整生产提交 SHA>
export MIKKA_FIXTURE_RECEIPT=<已保存的 coordinator-fixtures.json 路径>
export MIKKA_FIXTURE_KIND=haiku
```

`MIKKA_FIXTURE_KIND=luna` 使用另一个已经绑定 Codex Luna 的测试 Bot，无需改模型选择。各脚本只有一次发送尝试；确认丢失不重发。

```bash
node scripts/acceptance/issue-1506-alex/coordinator-baseline.mjs first-text-stop
node scripts/acceptance/issue-1506-alex/coordinator-cache-turns.mjs complete-turns
node scripts/acceptance/issue-1506-alex/coordinator-tool-stop.mjs tool-call-stop
```

首字 baseline 发送一次合成数数请求，在第一个真实可见 text/reset 字符时调用一次正常 stop action。报告 send→firstText、headers、workflowRunId、live 推送计数、stop 请求与确认时间、committed、流终止种类，以及唯一一次停止后的权威 chat 状态。`firstTextTargetMet` 与 `status=observed` 分开；观察完成不等于达到 3 秒目标。客户端 deadline 取消不会记录为 EOF：共用 parser 只有真实底层 `done=true` 才返回 `eof`，取消返回 `timeout`，协议 error 单独失败。

跨轮脚本默认两条不同、短于 30 字答案的合成无工具消息；可用 `MIKKA_CACHE_TURNS=3` 取得三个样本。每轮最多 60 秒，顺序等待 committed 和真实 EOF，再且仅再读取一次 chat 确认 idle，然后发下一条；没有状态轮询或任意 sleep。出现错误后不继续下一轮，并对这次已尝试的自有消息执行一次 stop。缓存 read/write token 数据需从服务端日志与 workflowRunId 关联，脚本明确报告 `not_observed`，不会用耗时推断命中。

工具停止脚本仅请求只读 `web_search`，收到真实工具 running frame 时停止。`MIKKA_STOP_CASE` 只是计划标签；报告保留 `runtimeBoundary.classification=unverified`，必须由真实 tool audit / provider 日志判定是执行前还是执行中，不能把一个公开 frame 解释成工具已经开始或尚未开始。

这些脚本通过无 interval、无重连的 live socket 观察推送。它们不会证明网页或移动端客户端已经消费 live；客户端行为需要结合实际修复与真实消费者测试单独验收。

## 群停止：额外独立 fixture

`group-stop.mjs` 只在本次新 team 中创建一个新群。成员严格为 ACME 本人以及 receipt 中的两个测试 Bot，不访问原有群或私聊。公开用例仅提及选定的一个 Bot，合成消息禁止工具、委派任务、私聊及外部服务。私聊用例单独建群，只允许这两个测试 Bot 之间的一段合成计数交流；不会向既有私聊发送消息。

```bash
export MIKKA_GROUP_STOP_BOUNDARY=responding_bot
export MIKKA_GROUP_STOP_SCENARIO=public
node scripts/acceptance/issue-1506-alex/group-stop.mjs observe
```

默认边界是公开群状态中的“选定 Bot 正在响应”。仅收到一个新的、匹配 UUID 的 `group_chat` revision 后读取正常群消息状态，最多 8 次、总共最多 60 秒；这是有界事件驱动读取，没有 interval polling。正常 `GET messages` 产品路由可能唤醒已经排队的 worker，因此不能宣称它是无副作用的数据库观察。另一边界 `after_send` 在发送确认后立即 stop，并如实标记 `send_acknowledged`，不声称已经观察到 queued / provider-enter。

私聊用例设置 `MIKKA_GROUP_STOP_SCENARIO=private`。`MIKKA_FIXTURE_KIND` 指实际准备停止的生成模型，另一测试 Bot 发出第一条私聊。只有收到实际 revision 后读取到本消息的私聊链接、恰好一条私聊以及目标 Bot 正在响应，才额外读取一次 decision trace；必须存在按序的 `private_publish` 和目标 `generate` 记录，且还没有后续输出，才触发停止。这是主机生成收据，仍须 provider 开始/结束日志确认停止确实发生在模型运行期间。没有记录则失败并停止自己的群，不重试模型或循环读取 trace。

停止调用正常 `POST /api/conversations/<id>/stop`，之后只有一次最终状态读取和一次本消息 decision trace 读取。报告包括 stop 数量、最终 active/stopped、human cancellation 和 generate/publish/delegate 计数，不保存聊天或 prompt。公开 responding 状态、trace 的 generate entry 都不是 provider 已经中止的证明；`runtimeCancellation=pending_provider_logs` 保持到服务端关联验收。

群名绑定 public/private 场景、run key、模型 key、边界和 SHA 前八位。同一组参数发现既有群会拒绝再次发送。发送后无论观测成功或失败，都保留两个测试 Bot 的成员资格。执行者必须先关联实际 provider 结束，再对本群和本消息做一次数据库审计，确认停止后没有追加公开或私聊副作用，最后才运行独立 cleanup 移除成员并隐藏这个群。提前移除成员会掩盖取消隔离缺陷，因此不能替代审计。群行最后随这个测试 team 的正规删除清理；停止后仍 active 则保持 `needs_followup`。

## 独立清理

生产观测期间保留 Bot / 工作区；最终验收结束后按 receipt 清理。清理可以跨部署执行，不要求原版本仍在线，但仍严格校验账号和 fixture 所有权。

```bash
# provider 终止及最后一次副作用审计完成后：只停止并清理这个既有群，无新消息。
node scripts/acceptance/issue-1506-alex/group-stop.mjs cleanup <group-receipt.json>

# 如需提前隐藏两 Bot：只校验、必要时停止它们自己的聊天并隐藏，不删 team。
node scripts/acceptance/issue-1506-alex/coordinator-fixtures.mjs cleanup <coordinator-fixtures.json>

# 最终一次正常删除本次专属 team；提供所有群的已完成清理 receipt，没有群则省略。
node scripts/acceptance/issue-1506-alex/cleanup-workspace.mjs <coordinator-fixtures.json> <group-receipt.json...>
```

最终删除要求精确 workspace 名称/slug、本人唯一活跃管理员、无邀请、Bot 集合等于 receipt、全部 Bot 闲置、群集合等于已清理 receipt、群仅保留本人且没有 active turn；正常 deletion-impact 中 tasks/teams/purchasedPoints 必须为 0，Bot 数量必须相符。只调用一次 `workspace-settings.deleteWorkspace(id, exactName)`，确认丢失只读取一次正常 switcher 验证该 team 已不存在，不重试删除。多出来的资源或活跃聊天会阻断删除并留下失败 receipt，交由执行者查明；它不会主动停止非验收活动。

若 workspace setup 在创建后、生成 ready fixture receipt 前失败，`workspace.json` 保留了已知 UUID 和创建结果；最终清理 CLI 不接受伪造的 ready receipt。这种情况应由执行者依据 workspace receipt 和正常产品删除动作处理，不能扩大成按名字批量删除。

## 离线验证与证据界限

阶段一的 12 个 driver guards 加 3 个 phase/version guards 已通过；另有 13 个群/推送边界测试及 4 个最终删除边界测试通过。测试中全局 fetch 禁用，仅注入合成 normal API / NDJSON / socket 夹具，没有外网或模型请求。

```bash
node --test scripts/acceptance/issue-1506-alex/acceptance.test.mjs scripts/acceptance/issue-1506-alex/phase1.test.mjs
node --test scripts/acceptance/issue-1506-alex/group-stop.test.mjs scripts/acceptance/issue-1506-alex/cleanup-workspace.test.mjs
```

这些结果证明了脚本的授权范围、未知确认处理、失败不重发、有限读数与清理边界。它们不是生产模型时延、provider 取消、缓存命中、group stop 或实际客户端 live 行为的通过证明。生产结果必须以该次 artifact 和关联日志为准。
