# PR #1217 与 main 40d 的独立整合评审

**结论：在本次精确候选树中，未发现新的源码整合阻断；可以继续更新原 open PR（保持 hold、未合并）并运行该公开提交的 CI。本结论不授权合并，也不证明付费云运行、生产三条模型路径或固定小时验收通过。**

评审人：`/root/egress_1211`。评审方式是独立读源码、冲突与净差异、重算 Git 对象、核对作者已经执行的原始门禁和清理回执。本评审没有重跑测试、调用模型、访问生产数据、修改产品文件或移动 Git ref。

## 1. 精确对象与复核范围

| 对象 | 精确值 |
| --- | --- |
| 原 PR head | `cccef174f7a4e604a820a4b61f8521e8cdba100b` |
| 整合的 main | `40d03479ea8260b8934f609b84c7c9cb60a94b3c` |
| 共同祖先 | `fc2d401bde7b3f567b1288b01accd6fdeb433d0c` |
| 原 PR tree | `b7ace3493dbe0aad258eaaa245b528fdc95fcc32` |
| main tree，独立重算 | `58f14e63fc36cf12a936b9825604f71162586a84` |
| 最终候选 tree | `de3b83d85361e39a33ca9e5678d4ed37e6a33fe4` |
| 作者记录的本地双父 commit | `9441896ad27e0f072d11dc24194351623327a2ac` |
| 上述 commit 的父顺序 | `cccef174…`、`40d03479…` |

本地 commit 的记录不等于公开 ref 已发布；本评审接收的 manifest 明确 `publicBranchChanged: false`。随后若用 GitHub API 创建相同树和双父提交，commit ID 可以因身份或时间不同而改变，必须继续核对 tree 与 parents。

我完整阅读了本次五个冲突文件及其解决结果、主线 #1301 的完整四文件差异、最终相对 main 的 1,725 行净 patch，以及相对旧 PR 的所有八个相关变化文件。原 PR 中未变的关键 target/runtime/dispatch 实现也重新读取。未将主线其余无关的大量改动伪称为本轮逐行复审。

独立取回两棵完整公开 Git tree 后，以实际文件 mode、内容 blob 和目录顺序重算，候选树与作者 `git write-tree` 完全一致：相对 main 为 **27 路径，即 26 个内容文件及 1 个删除**；删除项只有 `lib/factory/cloud-stage-admission.ts`。其中 18 个内容 blob 与旧 PR 完全相同，另 8 个保留主线新增行为。`snapshot-credentials.test.ts` 仍存在，保留 probe/scrub 测试。

复核记录：`independent/tree-verification.json`、`independent/main-tree-api.json`、`independent/prior-tree-api.json`、`candidate/manifest.json`。

## 2. 五处冲突的实际解决

| 文件 | 已核对的解决与不变量 |
| --- | --- |
| `lib/cloud-computer/thread-machines.ts` | 删除旧 snapshot 依赖，同时保留主线 `factoryEventId`、`questionFingerprint`。#1301 的问题恢复锁定 helper 与 main 逐字相同；不把原 VM 的 question continuation 送入普通新任务替换分支。 |
| `lib/computer/auto-runtime.ts` | 不恢复父设备 `deviceIsOnline` 门槛；保留 main 创建 Coordinator Bot 后的 `botListChanged`。 |
| `lib/computer/queue-run.ts` | 使用 `cloudTaskTarget`，保留 `runListChanged`；不恢复 `sleepingFactoryCloudTarget` 或已移除的 `FactoryCloudStageAdmission`。 |
| `lib/factory/checks.ts` | 保留 fresh/retained 两种 target 与 `runListChanged`，不复活旧 admission 类型；fresh 与同任务恢复的能力来源仍分开校验。 |
| `lib/cloud-computer/thread-worker-logs.test.ts` | 保留授权查询返回无行、`rowCount: 0` 的拒绝夹具，同时纳入 main 的 `verify_worker` legacy 用例；未删阶段、回滚、拒绝或 canary 断言，也未恢复已不存在的 provider snapshot stub。 |

五个 resolved 文件与候选 source 的 blob 全部相同；精确 blob 清单见 `resolved/blob-hashes.json`。这些不是通过整文件选取一侧来消除冲突。

## 3. 关键语义评审

### 新任务可以在父电脑睡眠或尚无父 VM 时准入

`ensureBotTaskRuntime` 仍先核对真实 active Bot、Owner 和 workspace，并通过行锁串行分配父 metadata 与 display。第一次任务仅建立 runtime 元数据，不把未运行的父电脑标成已安装、在线或有 heartbeat，也不生成父机凭据。已有 enabled cloud device 被复用；disabled identity 拒绝，不能被静默重启或替换。

`recordBotRuntime` 对隐藏 repo/agent 的复用和 orphan 修复仍保留 Owner、设备、harness、名称/指令及其他 runtime 引用约束。`cloudTaskTarget` 通过真实 Bot、desktop、machine、agent、runtime、repository 关系确定目标，并保留各原路径的 workspace/computer policy；删掉的是父机运行状态依赖。不能据此推导所有 repository 工作都被 desktop 的 policy 处理，原两种用途的授权差别仍在。

Factory 新任务检查使用官方任务模板能力；带 question continuation 的检查仍要求 owned 原任务 VM 和实际 installed harness。本机路径仍要求 online 与 installed。`automatic-dispatch.ts` 的 repository 登记继续传递同一 `tx`，没有用嵌套提交提前逃出调用者事务。

证据：`candidate/source/lib/computer/{task-runtime,bot-runtime,cloud-task-target}.ts`、`lib/factory/{automatic-dispatch,checks}.ts`；真实 PG 日志中的 first-use、sleeping-parent、disabled-identity、no-repository deliverable 和 fresh-capability 断言均通过。

### 同一个任务中途问答仍恢复原 VM 与原 SID

我独立比较了 `QuestionRuntimeUpgrade` 与 `lockQuestionRuntimeUpgrade` 的整个区块，它与 main #1301 逐字相同。该 helper 仍锁定当前 task，再核对 question/run；要求同 Owner、issue、attempt、stage、candidate、request epoch，且 question 已回答、未过期、处于可恢复状态。

子 run 必须是当前 queued、尚未开始、没有新 SID、没有 Stop、没有 active lease 的原恢复对象；原 run、原 SID、device、repo、agent 不能漂移。不可变 resume/recovery receipt、answer fingerprint、回答者/来源/input 以及保存的 task snapshot 参与匹配；冻结 definition digest、harness、model、subscription/API-key identity 和 base branch 保留校验。

worker 升级发生在**原任务 VM**：staging、切换、rollback、bootstrap 处重复校验 receipt 与当前状态。原 VM 不可用时不能创建或接管另一台 VM；active child、改变的 claim/lease、Owner Stop 或任一 currentness 漂移不能被旧回调覆盖。no-repository official desktop 分支恢复原 display lease，也不更换原设备或 native session。

`freshTemplate` 是只在实际 fresh 创建/允许替换时执行的 lazy 分支；exact question wake 不因新模板配置变化而强制换机。用户要求“每个新任务使用 fresh 环境”没有被解释成“同任务每次回答问题换 VM”。

证据：`candidate/source/lib/cloud-computer/thread-machines.ts` 中 helper、exact-question、upgrade、bootstrap 与 catch 分支；`gate-proof/logs/mikka-1217-main40-pg-origin-fixed-task-runtime-pg.log` 中 execute/review/verify 原 VM 升级，以及 epoch、attempt、stage、receipt、Stop、claim、lease、workspace 漂移和 bootstrap rollback 用例。Factory 日志另覆盖 review/verify 在 running/paused 原 VM 上保留原 session、issue 和 candidate。

### 主线失败收尾与通知未丢失

`reservedStartLease` 仅在当前 provisioning lease 实际 COMMIT 后登记；只有普通 fresh start 的失败会携带其私有 lease proof。question/refresh/retained 失败仍先走各自原有处理，不把精确恢复误报为新的终态失败。catch 区块与两个父版本逐字相同。真实 PG 覆盖 late startup failure 不能覆盖 claimed run、live lease、foreign workspace、Owner Stop 或已更换的 lease。

main 的列表事件继续在实际写入事务中登记：Coordinator Bot 创建的 `botListChanged`、队列插入和 Factory claim 的 `runListChanged`、带 `rowCount` 保护的 stop 通知均保留。replay 不产生新的插入通知；普通续期语义未在冲突中扩宽。`computer/store.db.test.ts` 对新增 live scope 做显式比较，并保留原视图的完整断言。

本次还独立逐 blob 核对 main 的七个 runtime/Web 发布文件和 `thread-worker-logs.ts`：全部等于 `40d03479…`。最终净 diff 的 `package.json` 仅增加本 PR 的 task-runtime 测试入口，没有移除 main 的 question wake、live、approval 或发布脚本。

## 4. 真实门禁与失败保留

以下是作者已执行的本地门禁，评审者检查了原日志、两个 runner 的完整源码/差异和每个 gate 的 exit receipt，**没有再执行一遍**。产品与测试源码在两轮之间保持同一树 `de3b83…`。

| 门禁 | 第一轮 | 最终可采用结果 |
| --- | --- | --- |
| `test:cloud-limits` | 29/29；随后 probe/glob 11/11；0 skip；exit 0 | 同一源码上的该次结果保留，没有无关重跑 |
| 八文件 task/runtime/provider/Factory-end 真实 PG | 63 pass / 73 tests，10 fail，0 skip；exit 1 | 新隔离 role/DB 上 **119/119，0 skip，exit 0** |
| `test:factory-checks-db` 真实 PG | 62 pass / 65 tests，3 fail，0 skip；exit 1 | 新隔离 role/DB 上 **138/138，0 skip，exit 0** |
| `next typegen` / Workflow 编译 | exit 0，149 steps / 6 workflows | 不称为完整生产 Next build |
| `pnpm typecheck` | exit 0 | 同一源码结果保留 |
| `oxlint --deny-warnings` | exit 0，0 warning / error | 3,008 files、96 rules |
| 相对实际 PR base 40d 的 `git diff --check` | 空输出、exit 0 | 不混同旧 head 对新增 main 文件的检查 |

第一轮 PG 的实际阻断是外部 runner 将 `BETTER_AUTH_URL` 写成 `https://example.invalid/mikka`。main 的 `lib/auth-email.ts` 要求 URL 与其解析后的纯 origin 相等，因而在模块加载时抛出 `Invalid authentication email origin`。我另行亲读了 main 该校验源码。第二轮仅把 runner URL 改为 `https://example.invalid`、使用新日志前缀，并只重跑两项失败的 PG 门禁；没有改鉴权 guard、产品代码、断言或 CI 开关。由于首轮若干模块未加载，其测试计数与第二轮完整运行不同，不能把第一轮失败改写为已通过。

第一轮时间为 **01:52:48.930–01:53:51.280 UTC**；修正入口后的 PG 为 **01:56:26.426–01:58:08.312 UTC**。两轮原始日志与 receipt 全保留。

其他真实限制也保留：首次使用环境默认 pnpm 11 遇到 `ERR_PNPM_IGNORED_BUILDS`；随后明确使用仓库要求的 pnpm 10.34.3 正常安装。成功安装日志仍有既有 build-script / desktop CLI bin 警告，不将它描述成无警告安装。相对旧 PR head 的 diff-check 指出四个从 main 继承文件的 EOF 空行；相对实际 main base 的净 diff-check 通过，未为此扩大产品改动。

哈希复核：15 份原始日志的 bytes 与 SHA-256 均逐一匹配作者 manifest，记录于 `independent/gate-verification.json`；两个 runner 的精确差异单独保存为 `independent/runner-only.diff`。

## 5. 本轮清理范围

本轮使用已有、固定 **127.0.0.1:5432 / mikka_e2e** 的本地 bootstrap admin 创建一次性随机测试 role 与 `_e2e` 库。测试进程的随机密码只进入内存/环境；runner 以新 role 执行测试，没有提升该测试 role 为管理员。

runner 在 finally 中由已有本地 admin 枚举**该新 role 拥有**的数据库，校验 `_e2e` 名称后执行 **`DROP DATABASE … WITH (FORCE)`**，再删除该新 role，并查询 catalog 记录 absence。不得将本回执写成“零连接、普通 DROP”；那是其他任务的清理方式，本轮不是。

| 轮次 | 新建 role | finally 处理的该 role 自有库 | 最后回执 |
| --- | --- | --- | --- |
| 第一轮 | `mikka_merge1217_f482a16a973c` | `mikka_merge1217_f482a16a973c_e2e`；`factory193_consumers_9611bec3aa23418e8a8212a3845ba53e_e2e` | `databasesAbsent: true`、`roleAbsent: true` |
| 修正 origin 后 | `mikka_merge1217_33d37277a982` | `mikka_merge1217_33d37277a982_e2e`；`factory193_consumers_85a558a9ddaa4575a9b015614810e48b_e2e` | `databasesAbsent: true`、`roleAbsent: true` |

这是作者实际运行的本地隔离清理回执，评审者没有追加数据库调用。它不声称共享 sandbox 的所有其他任务资源均已删除，不涉及生产数据库、生产 Neon 配置或其他人的 role。

## 6. 发布与验收边界

在上述精确范围内没有发现必须再改产品的整合问题。原 open PR 保持 hold、未合并，可以按正常双父历史与 CAS 更新；随后必须检查新公开 head 的 CI，不能沿用旧 head 的 CI 名义替代。

这组证据是实际 PostgreSQL 与本地 provider/HTTP fixture 的行为测试，以及类型、Workflow 编译和源码检查。它没有运行真实付费 E2B/订阅模型 cloud leg，没有证明生产 Web/runtime 同版发布、真实生产问答恢复、三条指定模型路径或固定小时性能窗口已通过。生产 gate 及 issue 正文要求继续保留，本评审不作豁免。

## 7. 归档校验

| 包 | bytes | SHA-256 |
| --- | --- | --- |
| `final-source.tar.gz` | 627391 | `939fea33e1125fa3e83572358d58c6795338383d306d51092a828b37f5b2c9e7` |
| `gate-proof.tar.gz` | 30681 | `61cb3275f03362b56fdd2f739776aae91f2cc16e96ddebedd37f74786d34945f` |

独立证据文件为本报告、对应 JSON、`independent/tree-verification.json`、`independent/gate-verification.json` 和 `independent/runner-only.diff`。新增报告不修改作者已冻结的源码或原始日志 manifest。
