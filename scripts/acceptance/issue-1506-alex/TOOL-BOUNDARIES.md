# #1490 / #1506：before-tool 与 during-tool 的真实样本

本稿只复用 ACME 本人独立工作区中的 retained Haiku / Luna Bot 和正常登录、RPC、NDJSON、live ticket。无新工作区、模型切换、授权修改、任务或机器创建。作者没有发生产模型请求，所有入口仍需执行者明确启用。不会修改现有 continuation/control。

## 已有能力和证据缺口

- `lib/coordinator/stream-response.ts` 把模型 `tool-call` 投影为 public `tool/running`；它不代表工具主体已进入。
- `instrumentTools` 先等待 `beforeAgentTool`，再检查 SDK 原始 abort signal。新的 `tool_finished.outcome=stopped` 不可变审计证明 post-audit 守卫跳过了工具主体。
- `tool_started` 是 before audit 的记录。单独看到它、或只看到 execution completed，都不能证明实际 body 已运行／结束。
- 普通 Bot definition execution view 没有工具审计事件列表。现有 `web_search` 日志只有结尾 outcome/ms，没有 run/call 和独立 body 起止。现有 Workflow 管理只读事件可辅助定位，但仓库自己的 migration 验收已说明 optimistic inline 的 step 元数据可能在业务执行后才持久化；不能把 `step_started.createdAt` 当成精确 body-enter。
- 当前 Vercel CLI 文档说明 v64 的 `logs --follow` 已不再流式输出，因此这里不依赖它，也不通过 GET 轮询日志触发停止：[官方 logs 文档](https://vercel.com/docs/cli/logs)。

产品补丁 `tool-boundary-timing-current.patch` 只为现有 `webSearchStep` 和正常 stop hook 递送补内容无关日志。web search 在同一个 Node step 内记录真实 body 开始／结束，结束先取时间再查询已有 step metadata；callId 只保留 SHA256 前 12 位。stop 在既有 `resumeHook` 前后取服务器绝对时间，只有成功递送才打 accepted 日志。结果、异常、审计、重试与工具实现保持原样，额外数据库读、Workflow step、模型调用均为 0。

## 每次只采一个样本

执行前必须把 `MIKKA_ACCEPTANCE_SHA` 固定到包含诊断补丁的实际生产完整 SHA，并提供原 ready fixture receipt。普通验收入口继续是 `coordinator-tool-stop.mjs tool-call-stop`，选择实际模型的 `MIKKA_FIXTURE_KIND=haiku|luna`。

| `MIKKA_STOP_CASE` | 实际触发 | 此时能声称的事实 |
|---|---|---|
| `before_tool` | 第一条真实 `web_search/running` 后立即正常 Stop | 收到了模型工具调用；执行边界待审计 |
| `during_tool` | 同一条真实事件后仅一次固定 600ms timer，再正常 Stop | 客户端按预定延迟发出停止；执行边界待日志 |
| `observe` | 与 before_tool 一样立即 Stop | 无指定目标，只记录实际边界 |

600ms 仅在验收 driver 中，不写产品，不发额外读请求，不替换模型，不阻塞实际工具。若这期间工具已经结束，仍保留该样本；若 stream error，取消待触发 timer 并只做一次正常错误清理 Stop，报告失败。没有重新发送消息或重跑原样本的逻辑。

每个 report 固定 `sample.attempts=1`，`countedEvenIfBoundaryMissed=true`，记录实际 delay、streamId、server correlation 用 callRef、EOF 和正常 Stop 收据。所有样本都属于分母；后续新的独立样本不能抹掉旧的未覆盖或失败。当前 continuation schema 没有 stop-case 字段，执行者应在单独审核的调用环境中明确设定它，不依赖默认值来区分 before/during。

## 结束之后的严格判定

先限定实际 deployment 和 workflowRunId 读取两类 runtime log；不要输出同请求的工具内容或任意错误原文。等待真实 `coordinator_tool_timing` terminal 后，再使用已有授权数据库身份执行一次 `tool-audit-metadata.sql`，仅返回精确 owner / Bot / workspace / wrun:round 的不可变工具审计元数据。该 SQL 不负责证明 application SHA；SHA 来自实际部署和 driver 的前后版本核验。未拿到 terminal 不能用日志缺席推断 body 没有执行。

把白名单日志字段填入 SQL 输出的 `toolTimings` / `stopTimings`，交给纯离线分类器：

```bash
node scripts/acceptance/issue-1506-alex/tool-boundary-evidence.mjs \
  <tool-observation.json> <bounded-server-evidence.json> <ready-fixtures.json>
```

判定规则：

- **before_tool**：同一 execution / call 的唯一 start 和 finish，finish 明确为 `stopped`，且无矛盾的 body timing。证明来自守卫的不可变 stopped outcome，不是日志缺席。
- **during_tool**：同一 call 的唯一真实 body attempt、最终 finish 审计，且严格满足 `toolStart < serverStopRequested <= serverStopAck < toolEnd`。整个服务器停止递送区间必须在真实主体区间内部。runner 与服务端的时钟差不会参与比较。
- 工具先完成、部分重叠、边界相等、重复 attempt、缺 finish、缺终止日志、多个工具、多个 stop、scope 不符，都不能算请求目标通过。
- 正好落在另一边界时仍记录实际 classification，同时该请求目标为 `not_covered`。额外 source 字段不透传到报告。

`status=covered` 只表示这个工具时序边界有证据；`overallAcceptance` 一直保留 `requires_final_side_effect_and_provider_review`。#1490 还需要执行者核对停止后的聊天内容保留／stopped marker、已在运行的只读工具最终完成一次、没有后续模型或工具、没有迟到聊天追加等事实。不能仅凭一次 idle 读或 timing classifier 关闭 issue。

只读 web search 没有外部写动作。已经开始的工具允许完成；这与“停止之后不得启动后续工具／模型”分别验收。若 body 已终止，但最终不可变 finish 记录缺失，这也是应保留的实际失败证据，不能因为数据库写入权限理论上允许就假设 continuation 一定完成。

## 本地验证与剩余风险

新 driver / classifier：10 项离线测试通过，包含一次真实 Node 600ms timer、提前 EOF、错误取消 timer、严格区间与相等边界、缺审计、重复 attempt、scope、原样本分母和脱敏检查。全局 fetch 禁用，没有网络或模型请求。

新产品 timing helper：4 项真实 TypeScript helper 测试通过，覆盖实际起止、metadata 迟到不污染区间、原结果／异常保留、日志故障、stop 失败不冒充 accepted。完整 SDK / native registry 参数贯穿、typecheck / lint 与既有 post-audit stopped 回归由正常 PR CI 执行。补丁没有修改取消算法。

自然竞态可能使 immediate 或 600ms 样本落在其他时段，这是预期的未覆盖结果。web_search body 区间包括它原有 scope 校验；不把这条日志等同于外部搜索 provider 的请求已发出。`ok` / `unavailable` / `threw` 是受控 outcome，查询内容和错误原因不进入日志。生产日志丢失或 metadata 不完整时应保留证据缺口。
