# A43 owner recheck：受控拒绝的源码与只读事实

记录日期：2026-11-05 UTC。此报告只汇总已完成的源码审阅与授权只读投影；没有再次执行产品操作、配额刷新、模型或写事务。

## 已确认的阻断条件

A43 在 23:14:03.905 经正常 UI 点击一次 Retry review，客户端显示 `checkRetryFailed`。`factory-acceptance-pane.tsx` 的分支表明客户端捕获了 HTTP 状态小于 500 的 `RequestError`，但当时未捕获服务器 JSON。因此不能将任何具体 HTTP code/detail 冒称为已观测值。

已观测的官方订阅配额在 23:14:06.758 更新，晚于点击 2.853 秒。在唯一 POST 数据库日志时间 23:14:07.370，快照新鲜且全局 weekly window `used=1`，重置时间为 2026-11-06T00:00:00Z。该无 model 的窗口适用于冻结的 Haiku；另一个 `model=fable` 的 weekly window 不适用。原始纯函数重放得到 `exhausted`。这是确定不满足的正常 admission 条件；不是实际 HTTP body 的替代证据。

采样时、以及跨过 reset 但仍使用旧快照时，原函数均返回 `checking`。必须让后续正常产品操作取得新鲜官方配额；不能仅等待时钟越过 reset 就认定有可用额度。

证据：`recheck-gates-03-response.json`、`root-quota-replay.json`。根任务已在 #1210 comment6672295398 说明阻断条件与证据边界。

## 对应的不可变源码

- 已上线 merge：`82789ddf380841a4f3ea637d940005bbbd2cecdd`。
- 本地 source：`3f0daaf76f7c1da346275585bde806a3abd5a8ee`；远端等树 source：`79c3731ca819b3304efea0e8f98c936f4b28cd2b`。
- 本报告相关产品文件在上述 source 与 merge 中一致。merge 与 source 的差异只有先前 main 的 workflow 变更。
- 所有行号均针对该固定 source；审阅没有修改产品代码。

## GET capability 与 POST 的差异

GET `store.ts:509–523` 运行 ownership、历史 recovery 资格检查并返回能力。它不刷新官方用量、不执行冻结模型 admission、不创建新 runtime/check，也不提交新的 workspace membership 锁。

POST `store.ts:528–606` 的顺序是：

1. 校验 binding/reason/eventId；处理幂等回执及源 epoch；在只读事务中验证 owner、未停止、revision 与 recovery 资格。
2. 在锁外依次 `refreshRecheckSource(review)`、`refreshRecheckSource(verify)`，核对 native binding，并使用 `credentialStates` 刷新需要更新的官方配额。
3. 在权威事务中重新锁定 task，重新验证 recovery 的两条源记录、冻结选择与问题观察值。
4. `admitRecheckSource` 调用 `assertFrozenModelTarget`；核对当前 model catalogue、连接状态、provider health 和配额。
5. 按八个消费字段仍为 NULL 等条件归档旧问题；创建新 review attempt；dispatch 并验证实际排队的恢复 check。
6. 保存回执；事务提交前检查注册的 profile/membership。

因此 GET 显示能力与 POST 因正常 quota gate 拒绝可以同时成立。事务内任何后续错误均回滚新 attempt、事件和 task 更新；“回执和新 attempt 为零”本身不能定位拒绝发生在哪一步。锁外官方配额刷新可以独立留下新快照。

## 受控 HTTP 返回及源码条件

| 层 | 状态 / code | 条件 |
| --- | --- | --- |
| HTTP 入口 | 401 `authRequired` | 缺少 session userId。 |
| HTTP 入口 | 403 `originRejected` | POST 的 Origin 缺失、无效，或与 `request.url` 的 origin 不精确相同；GET 无此门槛。 |
| HTTP 入口 | 404 `factoryNotFound` | taskId 不合法，或 ownership/source/issue/Bot fence 不满足。 |
| HTTP 入口 | 422 `factoryInvalid` | strict 请求 schema、binding/reason/eventId 或 body taskId 校验失败。 |
| recheck | 409 `factoryStopped` / `factoryReplayMismatch` / `factoryStale` | task 停止、event 重放内容不符、revision/epoch/question 观察值失效或归档更新未命中。 |
| recheck / check | 409 `factoryCheckBindingMismatch` | recovery 不再成立、冻结选择变化、实际新 check 与历史冻结源不一致等。 |
| adapter / check | 409 `factoryDispatchAdapterRequired`、`factoryEvidenceMismatch`、`factoryCheckHarnessUnavailable`、`factoryCheckCommandRequired`、`factorySourceMismatch` | 缺 dispatch adapter；candidate 证据、当前 harness、命令、生产源或 handoff 条件不满足。 |
| admission | 409 `agentProfileUnavailable` | 第二阶段事务捕获 `AgentProfileError` / `AgentProfileAdmissionError` 并包装；例如 `agentProfileModelUnavailable` 的闭集 detail `quota`、`checking`、`expired`、`paused`、`missing`、`removed`、`model_gone`、`key_refused`、`balance` 或 `provider_unavailable`。 |

`http.ts:90–100` 只将 `FactoryError` 转成上述 JSON：notFound 为 404，invalid 为 422，其余为 409。原实现没有为受控拒绝记录 code/cause。非 `FactoryError` 不因其自身携带 status 就自动成为这里的 409；例如锁外 refresh 的原始错误不受第二阶段事务 catch 包装。该表列出本路径相关门槛，不能反推本次实际返回的 code。

源码定位：`app/api/factory/tasks/[taskId]/route.ts:18–29`，`lib/factory/http.ts:59–100`，`lib/factory/store.ts:528–606`，`lib/factory/candidate-recheck.ts:117–130`，`lib/factory/agent-profile.ts:202–214`，`lib/model-order.ts:154–239`，`packages/protocol/src/subscription.ts:161–225`，`lib/factory/check-start-recovery.ts:150–160`。

## 唯一数据库日志的精确匹配

Vercel request `bfnqt-1793920444534-c1b90c0e2149` 的 23:14:07.370 数据库日志为 statement `1b5be69da5e9`、tables factory_events/factory_tasks、rows 0。按 `lib/db/egress-sample.ts:39` 对原 SQL 文本取 SHA256 前 12 位，精确匹配 `lib/factory/deliverable-snapshot.ts:74–78` 的 `readDeliverableSnapshotReceipt`。

该 SELECT 查询 `owner_deliverable_snapshot_recovery` 回执。函数紧随其后的 `if (!receipts.length) return null` 是正常分支；`resolveFactoryCandidateSha` 会在无回执时使用有效的原 producer deliverable SHA。本案 baseline 有 `d05417e7848871e511141e10a282ffb7998b0a79`。因此 rows 0 不是“candidate 缺失”的证据，也不是查错 task 的证据。

这条 SQL 可从历史 check 解析与新 check 配置路径到达，不能确定事务执行深度。但请求已经进入产品数据库读取层；不能将 Origin/session 的入口拒绝当作已经证实的原因。

## 生产只读投影汇总

| 证据 | 数据库时间 | 结果与限制 |
| --- | --- | --- |
| `recheck-gates-01-response.json` | 23:27:51.977 | 两个历史 checker 的 native binding、owner/workspace/route/connection/model/epoch 均匹配；connected、未 paused/removed，catalog 含 Haiku；agentProfile/apiKey key 均 absent。 |
| `recheck-gates-02-response.json` | 23:29:24.240 | 当前 runtime 与两个冻结 checker 的 agentId 均为 `c5dc010b-c4b4-4504-945f-9791f9d30300`；repo/workspace/device/ownership/desktop predicates 全部成立；parent sleeping、ready/enabled。 |
| `recheck-gates-03-response.json` | 23:31:10.038 | 两条源的 exactOrderCandidateExists 为 true；官方 quota 结构有效，23:14:06.758 的全局 weekly 已用尽。 |
| `recheck-gates-04-response.json` | 23:35:34.214 | 按真实 providerHealthStates 的目标账户/模型选择，健康观察集合为空；本次采样不存在会优先于 quota 的 health observation。不能由后来的空集合还原未知的实际 HTTP JSON。 |

01/02 由独立只读审计执行并逐项回传；03/04 与原纯函数重放已直接读取原始记录。各 SQL 投影也在同目录保存。所有生产查询在 READ ONLY / 5 秒约束下完成，不读凭据密文，不刷新、不调用模型。至 04 停止新增查询。Workspace membership 是未观测的后续提交门槛；没有为了全面覆盖而继续查询。

## 最小诊断的覆盖范围

#1462 在现有 POST `FactoryError` catch 调用 `logCodedError(error, {taskId})`，保留原 status、JSON、权限和 UI。现有 logger 只记录受限 code/detail/cause 名称与已验证 task UUID，不记录 message、stack、provider 文本或凭据。独立审阅与根任务的隐私/行为测试已完成。

它补上本次受控拒绝不可见的日志缺口；没有改变配额 admission，也不是 quota 修复。前置 401/403/schema 拒绝与非 FactoryError 不在该新增日志的覆盖内。多个无 detail 的 bindingMismatch guard 仍只能记录相同 code；本报告没有为此扩大产品改动。

下一步由根任务正常发布该诊断并在新的官方配额可用后执行已授权的一次正常 UI 动作；本代理不发起生产重试、模型运行或写入。
