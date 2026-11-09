# PR1788 与 d72 的有限集成审查

## 结论

未发现需要先把 d72 普通合并进 PR1788 分支才能集成的源码或协议阻断。0e→d72 的 71 个变更路径，与固定候选 d683/9ef 的 10 个路径及新增 run-end-paths fixture 路径没有交集。此结论仅来自下列调用链和固定 Git 对象；没有运行合并演练、测试、数据库或生产请求。

Root 已另行直接核验新 CI synthetic commit ca9a2a0f133fafc12a4aa4668dd6e2654395e84d，双亲为 d72a1982bf503b34ad4bc31ab6211cfe018af483 与 b7be7cc15f6b59dd11ae1c286640553432376fe6，tree 为 13fa2d9337fe66c6c8e194c704c36e44c171f2ea。其实际已选 CI 将验证这个组合；当前没有声明通过。PR 元数据仍显示旧 base.sha=0e，不足以推翻已核验的执行提交双亲。该条由 Root 提供，本审查没有重复读取 CI。

## 具体调用与风险

| 接点 | 已核变化 | 对本候选的结论 |
|---|---|---|
| Factory store/dispatch/contract 与 run-end-paths 上游原文件 | 四个 blob 在 0e/d72 完全相同；新 fixture 绑定既有 owned Bot 与 source issue | 原 factorySourceMismatch 守卫没有放宽或改变；未新增必填参数 |
| MCP producer/writer/backend/catalogue 与正式 cloud-startup driver | 所列直接接点的 blob 均守恒，daemon/protocol 没有 incoming 路径 | traceparent 单键修复、真实目录回归和原计时字段不存在已识别新接口冲突 |
| claim.ts / run-completion-effects.ts | 增加 taskActivityChanged；启用 live gateway 时 after-commit 查关联 Factory Task 并通知 | 授权签名、claim 返回值、lease/final fence 不变；有条件新增后置查询，不能称整个 Task 成本与 0e 相同 |
| events route / run-events.ts | preparing→running 更新移进原事件持久化事务并增加活动通知 | chunk/阶段字段未改；事务时点变化需由实际组合 CI 验证 |
| thread-machines / lifecycle / retained-deliverable | 增加父 run 锁序、session history、精确 kill-ACK 收尾 | 原 owner/workspace/operationId 等条件保留；未发现新 daemon 入参。新增 SQL 与触发器是真实行为变化 |
| stage-progress / spec-artifact | syncFactoryPresentation 接入 spec artifact；仅 stage=spec 且 status=passed 才执行后续工作 | needsSpec:false 的本 fixture 未被强加 spec 前置；真实 spec 路径有新增授权查询/写入，旧成本证明不可外推 |
| lock / package / workspace / DB suite inventory | ffmpeg-static 及其构建许可、新活动套件和两条迁移 | 若显式合并这份 lock，必须使用组合源对应依赖；旧 c45d 安装回执不能覆盖新 lock。此事实不额外要求分支先合 main |

run-end-paths fixture 使用实际 drizzle 目录、orderMigrations 并遍历安装全部 SQL；它不是固定少量表的手写 schema。新增 thread_machine_sessions 迁移在实际组合下会自然被纳入。Root 已报告本次修复在原候选上 PG17 12/12；本审查未重测，也不把该结果改称 d72 组合已通过。

## 边界与后续

原 ui-policy.yml 的 PR 路径使用 actions/checkout，相关 core/integration/source/daemon/DB job 没有 ref 覆盖；ci-selection.yml 同样没有 head-only ref。结合 Root 已核 actual synthetic 身份，继续沿原已选门槛核验实际执行源即可，不新增主线合并或重复全检门槛。

当前仅能排除已审接点的静态阻断，不能证明 d72 的所有新增功能、迁移或完整 Task SQL/rows/wire。旧失败、未执行项、正式六例 0 新执行/无新增 PASS 的边界保持。没有修改产品、索引、分支或远端，没有新增资源、SQL、模型或 CI 调用。

后续 P0/Team 若合入，仍须保留 workflows/coordinator/tools.ts 中五处 botId 转发；当前 d72 的该文件仍是 0e 的相同 blob。本方两工具描述只做局部 hunk，不得整文件覆盖后继执行参数。

全部固定源、逐路径 blob、路径交集和 fixture 身份见 source-index.json。