# #1217 三方整合独立复核

复核者：egress_1211。结论：**已复核的三方冲突解决及其测试范围内未发现阻断项，可以继续更新原 PR 并运行最终 CI。付费 cloud leg 与生产验收仍未通过，不能据此合并。**

## 精确对象和证据完整性

- 原 PR head：`f0f2d077613a2de21a6cefb2f314a6dc8d93c89b`
- 合入 main：`2b25caad1608df6a2a54d5e18e798b3c9807ce89`
- 最终 tree：`5709b51c3f0c85feecef82202a3a23f248d7169f`
- 阅读资料：`final-vs-main.patch`、`final-vs-old-head.patch`、`final-filemap.json`、原始 merge log、两轮 gate metadata 和相关原始日志。
- 25 个有内容文件的 Git blob 均重新计算并与 filemap SHA 相符，另一个条目是删除旧 cloud-stage-admission。两轮 metadata 引用的 16 个日志 SHA-256 均重新计算一致。
- 相对原 PR head 仅有四个文件变化：thread-machines.ts、thread-worker-logs.test.ts、checks.db.test.ts、run-provider-fallback-cloud.db.test.ts。
- 另从 GitHub 直接读取固定 main 的 thread-worker-logs.ts、cloud-stage-handoff.ts，核对受限诊断和 durable handoff 的实际调用契约。

这是独立源码/测试内容及日志核验；本人没有重新运行这些 PG 测试，没有模型调用、云机唤醒或生产写入。

## 1. 无父机依赖与诊断阶段同时保留

最终 ensureThreadMachine 的 admission 查询仍按 run owner / computer binding workspace / repository owner 取行，但不再选择或要求父机 sandboxId。普通 task 仍从官方 harness / desktop template 取新环境，且不恢复旧 workspace snapshot 路径。保留 metadata 行并不等于要求父机运行。

新 main 的 execution_identity、question_machine、question_source、provider_state 等 phase 标记完整保留；正常新任务仍首先 revalidateExecutionIdentity。question continuation 对原 run / session、owner、workspace、Bot、issue、device、repo、原 thread machine 转交状态和活跃 worker lease 的检查没有移除。

catch 中日志调用先于 ROLLBACK 和 lease 清理。实际 logger 使用固定 errorClass / errorCode 白名单与有界数值，并吞掉诊断 getter/sink 自身异常，不输出 provider message、stack 或 cause。因此该合并不会让新诊断替代原异常或阻断原清理。旧原生 run 历史不因诊断改写。

新诊断单测原以 botSandboxId=null 制造 admission 拒绝，这与 #1217 正在删除的父机门槛冲突。改为授权 run 查询返回零行可真实命中 Thread unavailable；其余 phase、敏感占位数据不泄露、无 bootstrap effect、ROLLBACK、只清自身 lease、release 等断言保持。provider.snapshot 已从实际 provider 接口删除，删除对应不可达 mock 合理。

## 2. Factory 检查两组能力边界同时保留

configureFactoryCheck 对 fresh cloud task 使用已验证的 cloudTaskTarget，其官方模板提供 harness；retained question continuation 不获得 fresh 豁免，仍用 ownedCloudTaskTarget 核实际 VM custody 和已安装 capability。本地设备保持原 online + installed 条件。

checks.db.test.ts 同时保留以下两组：

- #1217 的 review / verify × running / paused retained VM 真实 PG 路径：同 issue/candidate/session/definition；缺 installed capability 事务回滚；错 owner/workspace/Bot/run/device/repo 或 disabled/ended VM 拒绝；旧 heartbeat 的 claim 拒绝，真实当前 heartbeat + running 后才可恢复。
- 新 main 的 report / deliverable × review / verify 回答路径：Owner 解释不会写入 verifyCommand 或 repository settings；同 candidate/stage/native session 不变；错误 owner、epoch、candidate、SHA、repo、environment、policy、非 waiting 状态拒绝；同 answer replay 不产生额外 run，原 waiting attempt 不伪装为通过。

两组在最终文件中均存在；不是选择一侧后丢失另一侧。

## 3. Provider recovery 保留持久移交与父机不唤醒

联合 fixture 按新 main 的 workflow 参数记录 actor / previousRunId / runId / providerContinuation。persistRunCompletion 后只创建 queued child 和 durable handoff，不在已结束 worker 的请求内启动 VM；真实 handoffFactoryCloudStage 再启动任务。

同时保留 #1217 约束：sleeping parent 的整行 machine/device、lease、heartbeat、capability 和 runtime identities 不变；新 harness 使用独立 task device；没有落到可用本地设备；parent 只做一次原 metadata registration；无第二 lifecycle、无网络请求。

新增 main 的三组控制仍在：

1. 旧 device token 撤销后由 host 接手 retained VM；失投重放面对已 running child 不再次 park/start。
2. 并发 handoff 第二次拒绝 provisioning，原 workerLeaseId / until 不被覆盖，只创建一台任务 VM。
3. foreign owner/workspace、无前驱、无 provider receipt、stop、terminal child、changed digest、已取消 issue 在 VM effect 前拒绝。

后续任务的模型健康记录测试仍拒绝显式指定失败模型。本次只读 fixture 使用合成 key/model 且断言零网络；它不代表任何真实模型调用或允许替换用户冻结的验收模型。

## 原始门禁与限制

已读原始记录：

| gate | 结果 |
| --- | --- |
| Factory PG | 135/135，0 skip |
| Provider PG | 7/7，0 skip |
| Cloud backend | 62/62，0 skip |
| Thread continuation | 25/25，0 skip |
| 首轮 cloud-limits | 28/29，保留真实 admission fixture 失败 |
| fixture-v2 cloud-limits | 29/29 + retained probe 11/11，0 skip |
| typegen / types / lint / diff | 已记录 exit 0；fixture-v2 types/lint/diff 再次 exit 0 |

首轮 tree 是 `9ba2c7d83ec9baf0a5e030b16d4a08e90628e80c`；最终 tree5709 只修上述诊断测试输入与过时 mock，不改产品。原失败及最终成功分别保留，没有把旧结果写成新 head 重跑。

此复核不证明真实 Claude/Codex 付费 cloud leg、生产首次启动、生产 Web deploy/version pin 或整小时目标。那些仍须按实际验收证据完成。
