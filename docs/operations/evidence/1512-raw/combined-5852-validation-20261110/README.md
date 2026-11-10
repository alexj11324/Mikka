# #1512 — Checkpoint 53：5852 正式验收与失败原件

此归档记录正式候选 `5852aa8832c07fdeef43665dd5e156ce5516e3ea` 的实际结果。**当前整体未通过，生产验收为 0/2。** 历史成功、单项功能成功和静态审查均不替代失败门禁。

完整文件与字节摘要见 [index.json](index.json)，独立冻结字节回读及 Native 重算见 [archive-verification.json](archive-verification.json)。本归档只是追加证据，不发布业务源码、不重跑 CI、不启动资源。

## 正式来源与结果

正式 head 的 tree 为 `42d33eb7faf77d7049607523599de9374e065660`，父提交为 G `363065a84264e6a32134e64ef6aa2b3c690d0a02` 和 main `60401d31fb33b7f272cb0262df58d3d2008280b4`。Actions 实际 checkout 为 `9faa0e581b370237fe541ce3087c28a334ddb798`，与 head 同树。结果只归属于该来源和 attempt 1。

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| 12 个 workflow | 10 success / 2 failure | 全部终态 |
| 41 个不同 Actions job | 34 success / 3 failure / 4 skipped | 42 checks 还包含 GitGuardian success；另有 6 个无 checks 的第三方 queued suites，仍未知 |
| Source | 361 passed，0 failed，0 skipped | 不替代 Core/Integration 的实际执行 |
| Core / Integration | 58 / 29 个实际 target 成功 | 合并后的 personal-policy 24 个用例逐项执行且通过，保留 fresh Organization 拒绝与恢复反例 |
| Daemon | 1,591 passed，2 existing skipped | 140 个通过文件，另 1 个既有空文件 skipped |
| PostgreSQL shard 4 | failed | activity-actor suite 为 79 tests / 77 pass / 2 fail；其他三个 shard success |
| Database summary | failed | EXPECT_DB=true，DB_RESULT=failure，实际 exit 1 |
| macOS arm64 / Node 22.22.1 | failed | 首次安装与在线成功；restartLocal 的 launchctl bootstrap 返回 EIO 5 |
| Native packaged job | success | 功能成功与查询量验收分别判定，见下表 |
| UI strict | success | 七个 EXPECT=true 均 success；它未汇总 PostgreSQL 或独立 Local Node22 结果 |
| 生产链路 | 0/2，未开始 | Claude / Codex 官方订阅、PostHog 与完整清理验收尚未完成 |

详见 [正式 CI](formal-ci/index.json)、[正式 PG](formal-pg/index.json) 和 [Native](native/index.json)。

## Native 查询量仍失败

五份实际 JSON 原件全部保留，并按既有核验函数重新计算。24 records、12 checkpoints、8 segments、2,280 bucket cells 和 1,226 ordinal rows 算术一致，没有漏采查询；上下文与 statement 归属未知项仍保留。

| 原始窗口 | 查询数 | 判定 |
| --- | ---: | --- |
| Web 完整登录 | 438 | 对照 |
| Native 完整登录 | 448 | **失败，较 Web 多 10 次** |
| 首对 bundled 启动 | 116 | 原始 FIRST pair 1 |
| 首对 hosted 启动 | 224 | 116 ≤ 224 |

完整登录窗口没有跨结束边界的 RPC。首对 bundled 窗口保留 3 个 physical / 7 个 logical 跨结束边界请求，hosted 为 0；不能把较少查询全部归功于产品优化。没有改窗口、重选 pair、扣除未知项或增加无源码变化的重跑。

实际 Node 为 24.22.2，安装 daemon 为 0.0.567 / `08327db0f3e7b78fc296f82232ecf0afda6ecd5b`。main 已带入等待新 DOMContentLoaded 的 harness 变化，旧 d2c/R2 结果不能替代本次来源或作为单一变更的因果对照。五对冷启动 median 为 bundled 3,564.64 ms、hosted 3,266.66 ms；这是保留的观测值，未追加新的冷启动性能门禁。

## PostgreSQL 失败与修正候选

正式 PG 唯一失败叶子是 action-read-egress 的 fresh workspace-membership 观测断言：actual 0、expected 1；另一个失败是父测试聚合。该叶子尚未执行后续 team metadata=0 断言，因此本次正式日志不证明它通过。

静态独立复核确认：main 新增 organizationId 投影，SQL 从 id,kind 变为 id,kind,organizationId，而测试两处 matcher 仍用旧投影。[修正候选](source/pg-matcher-candidate.test.ts) 只改这两个字符串；fresh 读取次数 1、metadata 0、token pin、foreign workspace、成员移除/挂起、LiveRevision 及清理约束均保留。候选 commit 为 `907d281478d587fce6895ec6f48bec25f75dc085`，父为 5852；[审查](source/pg-matcher-review.json) 是静态 PASS，**不等于新的 PG 执行通过**。

独立的较早 G 修复曾在真实 PostgreSQL 17.11、同一容器重建数据库后取得 RED 14/16、GREEN 16/16：task-run 不再读取未使用的 team metadata，fresh membership 仍为 1。全部命令原件、数据库 reset、来源绑定与关闭证明见 [task-runs-pg17/index.json](task-runs-pg17/index.json)。该实验准确验证一行产品修复，不能覆盖之后合入 main 的正式失败。

## macOS 根因与资源边界

实际失败是 restartLocal 内部 `launchctl bootstrap` 返回 I/O error 5，导致 installer exit 1；原始日志未提供足够信息区分被吞掉的 bootout 失败、注销时序或其他 launchd 原因。不能将它直接定性为 race，也不能用无条件重试取得表面成功。[源码诊断](source/mac-source-diagnosis.json) 保留这些未知项。

G PostgreSQL 容器和网络已停止、删除，临时入口关闭后的两个 workflow 均 skipped、无 runner。正式 PG4 日志包含容器与网络移除。canonical generator VM 和 Native 取件 VM 均已停止、删除并精确同域 GET 404；本归档未创建资源。Native 应用的六阶段清理、租约释放与封存基线恢复均保留。

原 macOS fixture 的 finally 定义了 best-effort 清理，但缺独立最终进程/目录/bootout 成功回执；正式 Native workflow 也没有显式 PG stop/probe 回执。这些项目保持未知，不将 hosted job 终态或源码中的 finally 写成已证实清理。

## 源码整合与证据完整性

[source/closed-leaf-map.json](source/closed-leaf-map.json) 保留全部 6,925 个叶子和 892 个目录，main 的 6,854 个叶子原样保留、覆盖 71 路径、删除 0 路径。独立审查与作者回执均保留。canonical generator 在冻结输入上实际运行一次，生成 256 routes / 343 methods，输出和关闭回执在 canonical/ 中。

本归档对全部既有 payload 的冻结 Git 内容逐字节重算长度、SHA-256 和 Git blob SHA。Actions 原始日志、ZIP 的读取继续各归属于指定单一 reader；本归档未重新下载它们。没有保存临时签名下载 URL，没有新增 parity PNG 像素检查或生产 PostHog 截图声明。index 自身摘要由交付回执提供，避免自引用哈希。
