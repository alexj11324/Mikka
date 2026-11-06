# ALEX43 最终独立只读验收准备

准备时间：见 `preparation-manifest.json`。当前状态：**root 报告完成上线并于 2026-11-05T23:14:03.905Z 正常 UI 单击 Retry review；UI 返回通用失败。23:22:03 的只读快照显示没有已提交重查回执、新 attempt 或新 run，ALEX43 尚未完成最终验收。**

本目录保存 ALEX43 的独立只读核查，以及 root 的正常生产 UI 操作和发布诊断记录。审计查询没有生产写操作、凭据刷新或模型调用；root 的唯一正常 Retry review 操作另见 root-recheck-ui-action/result.json。ALEX79 和 R2 #1451 不是此轮门槛。

## 已完整读取的依据

- `../1210-final-acceptance-review.md`
- `../1210-a43-audit/readonly-queries.sql`
- `../1210-a43-audit/before.json`（本目录保存等字节副本，SHA256 见 manifest）
- 固定源码 `925245325fbff83ca1bd0579b819c3fcda397b2e`：`lib/factory/candidate-recheck.ts`、`check-start-recovery.ts` 的恢复校验、`store.ts` 的 Owner 回执与旧问题处理、`checks.ts` 的冻结 check 与 prompt 拼装、`question-command-sources.ts` 和 `question-execution-observations.ts` 的来源和快照合同。

当前验收准备源码已更新为 local `3f0daaf76f7c1da346275585bde806a3abd5a8ee`，已本地确认 tree 为 `277259bbe1cb177abc6bf9866dffabf64fe51e0f`；parent 提供的对应 PR #1449 remote head 是 `79c3731ca819b3304efea0e8f98c936f4b28cd2b`。上列六个已读的 Owner 回执、冻结检查和宿主证据源码文件，与先前 `925245325fbff83ca1bd0579b819c3fcda397b2e` 的 blob 均逐一相同。因此此前的合同理解与只读查询仍适用。parent 报告的新改动是同一 pane 兼容主线 #1457 的退回修改 / Artifact wrapper；本目录没有把 UI 或 CI 结果当成生产验收。

此处仅记录**准备源码身份**；没有宣称 PR 已合并、生产已 READY、新检查已经运行或 ALEX43 已验收。2026-11-05 23:04 UTC 的最小 before 已获 root 明确授权；其他生产阶段继续等待 root 通知。

## 具体核查顺序

1. 收到 root 的部署确认和触发消息后，记录部署版本、READY 时间和实际新 review/verify run IDs。若 root 已保存本次点击前的完整只读快照，复用该原件；否则只补当前 task/candidate、旧问题八 NULL、四个原报告指纹、父机状态这些最小项。不会重查全部历史工具记录。
2. 查询真实 `owner_candidate_recheck` 回执与全部 `position > 4` 的 attempt。检查旧 binding、两个冻结源 run、candidate、epoch、questionDisposition 与新的 review attempt/run 对应。真实回执的操作在 `request.input.change.action`，旧 binding 在 `request.input.binding`，两项原检查在 `request.sources`；不存在要求顶层 `verifyRunId` 的合同。review 一创建/开始运行就用 `running-vm-sample.sql` 保存第一份带数据库时间的 run/SID/VM/native claim 和父机快照，不等最终报告后才查可能已回收的线程 VM。
3. verify 一创建/开始运行时同样立即保存运行中 VM 快照；这两个时点由 root 的生产进度通知触发，不在部署前轮询。对本轮 review 和 verify 分别读取实际 `inspect_artifact` 输入/输出对、宿主冻结 check、实际宿主提示片段及报告。保留所有新增 attempt 的结果，绝不只挑最后一个 passed。新 run IDs 必须与 root 提供的实际 IDs 一致；若首份采样仍 queued 且无 VM，则明确记录该状态，在首次 running 时补一份，不把 NULL 推断为实际 VM。
4. 两个检查满足原六项且没有缺失证据后，向 root 报告可进行正常 Owner 验收；由 root 操作 UI。随后再只读核对唯一接受记录、task 最终状态、零活动 run/lease、候选/epoch/交付 HEAD 未变、旧报告未改、旧过期问题没有答案或 continuation、父机仍 sleeping。
5. 原始 SQL、原始响应、数据库 observedAt、本地收集时间和逐项判断都保存在本目录。发现缺失、失败或绑定不一致就明确报告具体 blocker，不补造结论，不触发重试或付费模型。

## 原六项逐项证据

| 项目 | 必须实际看到的证据 |
|---|---|
| 1. 文件内容与范围 | `mikka-question-recovery-cc-20261104-1237.txt`；精确 UTF-8 `mikka-group-policy-v3\npath=claude-code\nstatus=ready\n`；52 bytes；SHA256 `05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6`；只有指定文件 |
| 2. 提问前真实检查 | 已冻结的三对 Bash 原件：create、read/bytes/hash/BOM、Git status/scope；实际输出与 exit code；三个输出 chunk IDs 见 `expected.json` |
| 3. 真实问题与等待 | 精确决策问题、ask_human 的输入和输出 chunk、源 run `stopped/asked_human`、宿主 run_question / wait 事件；没有把历史等待改写为成功 |
| 4. 正常回答与原会话继续 | 已保存的 human answer 与不可变 question_resume receipt；同 task、同原 SID；producer 的真实 questionContinuation；源/producer 完整关闭的 tool index 分别截至 seq 29 / 20，不重复文件命令；明确这种索引不是 OS 审计 |
| 5. 两个独立 artifact 检查 | review、verify 各自实际 `inspect_artifact` 输入包含完整 expectedUtf8；run/toolCallId 唯一配对且输出时序正确；bytes=52、上述 hash、HEAD=`d05417e7848871e511141e10a282ffb7998b0a79`、committedSha256 同值、contentMatchesGit=true、matchesExpectedUtf8=true、完整 contentUtf8 相同、textUnavailable=null |
| 6. 严格历史来源绑定 | `attempt.output.check.questionCommandSources` 精确关联原源 run/SID、resume receipt、candidate HEAD、输出 chunk 和观察时间；`questionExecutionObservation` 冻结 watermark/digest；`run.prompt` 实际包含同源生命周期和命令原件；报告逐项引用原 chunk/event，保持源 stopped 状态，不把历史命令说成独立检查中新执行 |

main `565c7dfb0d753325a782766686ba23a13bb08c54` 广告了只读 `inspect_repository`。该工具不能替代第 5 项要求的 `inspect_artifact`，也不能替代其他五项。

## 冻结身份与不变量

- task `e42571e5-58f7-40e3-9418-c02ee8843fe6`，issue `0b9e6f79-790b-4931-aa54-2f45f5d142de`，candidate `2f338962-c690-4ba7-bc63-6c73a9de3acb`，epoch `4ad02e70-8015-5eac-87f4-a96fbd775d14`。
- 交付 HEAD 取 producer.report.deliverableCommit。deliverable 的 candidate.sha 为 NULL 正常；producer.sourceCommit `054e64…` 是执行前基线，不能用作交付 HEAD。
- 新 review/verify 各自继续原阶段冻结的官方 Claude Code `claude-haiku-5-5` 订阅、binding `0e5edf2d-2653-475e-8693-b53ceafa7c11`、connection `93b6ab23-900b-4e18-9ea0-baccf2d104ce`、revision 2、route `claude_code_cli`。核对实际 native claim，API claim 为 false；providerObservedModel 如仍为 NULL 就如实保留。
- pre-Profile 的原 modelDispatch.entry 不取当前偏好重选，不补造 Agent Profile。保存原阶段 policyCeiling 后检查其与原 check policy 的交集，不能把新 policyCeiling 误要求为旧 raw policyCeiling 逐字相等。
- 新 review、verify 使用各自全新 SID / VM，不能复用执行 SID、旧检查 SID、旧 VM 或父机。检查 thread machine 创建时间、sandbox ID 与新 run 对应。
- 父机 `ipa60du803guuiqnyzqan` 保持 sleeping，lastActiveAt `2026-11-05T14:48:42.215Z` 不变。新的线程 VM 不代表父机被唤醒。
- 原四个 run 的 status/stopReason/SID/start/finish/报告 MD5 必须与 before.json 一致；不把原 verify 改成成功。
- 旧 verify 问题 `31b87a5f-7be6-49e9-9031-126dd2144007` 的 expiresAt 保持 `2026-11-05T20:15:32.526Z`。正常到期标记后 status=expired；`answerId, answerSource, answerSourceEventId, answerFingerprint, answeredAt, answer, result, continuationRunId` 八字段均 NULL。它不能获得回答、延期或 continuation。
- 最终只有一次此 candidate 的正常 Owner 接受；没有新增 execute/repair candidate，没有新的 source epoch，没有遗留 active run 或有效 lease。

## SQL 与保存约定

`readonly-queries.sql` 是此前已核对的最小核心查询等字节副本。`supplemental-readonly-queries.sql` 只补原阶段策略/VM、新 check 的实际 prompt 宿主片段、工具元数据索引和最终 Owner 事件。`running-vm-sample.sql` 是 review/verify 运行期及时采样的小批次。现有 Neon `run_sql_transaction` connector 已确认仍暴露；已执行一次获授权的最小 before 只读事务；没有执行无目的的生产试连。执行时拆成有名字的小批次，每批先 `SET TRANSACTION READ ONLY`、`SET LOCAL statement_timeout='5s'`。不运行 DML、DDL、存储过程或触发模型的 API。

`expected.json` 固定机器可比对预期；其中 newRunIds 当前为 NULL，productionObservation 仅指向这次 before。最小 before 与准备结论均不属于最终生产验收结果。

## 点击前最小 before（实际生产只读）

Root 报告 #1449 已普通 merge 为 `82789ddf380841a4f3ea637d940005bbbd2cecdd` / tree `21e20c013e5b7859d8c4daf258fa11024aec5b34`；采集授权时 Web 部署仍在进行中，本目录没有独立宣称 READY。数据库采样时间为 `2026-11-05T23:04:14.917Z` 至 `2026-11-05T23:04:14.924Z`。

原始 SQL、请求、响应、收集时间分别在 `production-before-minimal.sql`、`production-before-minimal-request.json`、`production-before-minimal-response.json`、`production-before-minimal-timing.json`。`production-before-comparison.json` 直接读取原始 `../1210-a43-audit/before.json` 逐字段比较，禁止从 README/summary 抄录哈希，也没有按理论长度补改。

比较结果：97 个实际字段比较全部一致，差异 0。task 仍 verify/waiting、revision 13；原 candidate/epoch/交付 HEAD 不变；四旧 run 的状态、原因、SID、开始/结束与报告指纹完全一致；旧问题 waiting_user/revision 2，expiry 已真实过去且八个消耗字段全部 NULL；父机仍 sleeping 且 lastActiveAt 不变；recheck / acceptance / 新 attempt / active run / active lease 均为 0。最小数据库前置条件未发现 blocker，正常 Owner 操作仍须由服务器锁内重新验证完整准入。

## 单次 Retry review 后的实际阻塞

Root 报告同一次正常 UI 点击后出现 `Retry did not complete`，没有再次点击。只读事务实际数据库时间 `2026-11-05T23:22:03.184Z`–`2026-11-05T23:22:03.192Z`。原件保存为 `production-click01-observation.sql`、`production-click01-observation-request.json`、`production-click01-observation-response.json`、`production-click01-observation-timing.json`。

真实 `owner_candidate_recheck` 回执 0，所有 `position > 4` attempt 0，active run/lease 0，acceptance 0。task 仍 verify/waiting revision 13；原 candidate/epoch/交付 HEAD 不变；旧问题仍 waiting_user revision 2、原 expiry 和八 NULL 不变；父机 sleeping、lastActiveAt 不变。与 23:04 原始快照共有 48 个字段逐一相等。不存在可采的新 review/verify run、SID 或 VM。

这证明查询时没有可见的已提交重查回执或新 attempt；不能据此断言请求从未执行或没有回滚，也不能从 UI 的通用失败推断 quota、订阅或模型错误。具体失败代码/服务器异常尚未观察到。原冻结官方 Claude Code Haiku 订阅元数据在比较 JSON 中原样引用并标明历史采样时间，不冒充新的来源就绪/额度结论。原六项检查与最终 Owner 接受仍未发生。

## POST-only gates 最终诊断

源码确认的 01–04 最窄只读投影及其原件已完成。冻结来源/绑定/目录和当前 runtime 身份没有发现漂移；03 官方额度快照来自单击后 2.853 秒的 `23:14:06.758Z`，全局 weekly used=1、reset 为 `2026-11-06T00:00:00Z`。部署源码纯函数在实际 POST 数据库日志时刻返回 exhausted；当前及只越过 reset 而没有新官方快照均为 checking。04 当前优先健康观察为 0 行。详见 `recheck-gates-findings.md`、`recheck-gates-observations.json` 和 `root-quota-replay.json`。

原 HTTP 响应 body/实际 closed detail 未取得，所以报告明确区分可复现额度阻断与实测服务器 cause。按 root 指示停止额外 membership/全面查询；不声称未观察的后续门槛通过。原六项检查及最终 Owner 接受仍未发生。
