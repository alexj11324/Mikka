# #1512 — 当前候选完整 CI 与 Native 原件（Checkpoint 22）

**PR #1799 当前源码门禁已全部通过；生产 ACME 通过数仍为 0，#1512 保持 OPEN。**

## 精确来源

Head `025118ed953ab80803ac3ba9548c3a309c5c69b4`，实际 checkout `0b2b8a5296fa9ccda2a7f9921c26c2ff9b93ba02`，两者 tree `6da320a6f476624ba2e61ca7a1f5c704a3fdae25` 相同。

[CI 42573554116](https://github.com/alexj11324/Mikka/actions/runs/42573554116) 于 06:54:46 UTC 完成 success。43 check runs = 36 success + 7 原有条件 skip，0 失败或在途；9 个伴随 workflow 全部 success。此次没有 rerun 或 cancellation。

CP21 已保留本轮 Source/Core/Integration/Daemon/PG 与 Replay 修复的原件。本包补齐 image、14 份 companion 原日志及 Native/UIstrict 的实际原始证据。57 Core + 29 Integration 与本轮正式选集相等；PG 72 suites / 3787 tests 全 pass。Daemon 实际是 **1574 pass + 2 existing skips**，不能套用旧轮 1572。各 skip、mac 非阻塞配置及少数 fixture 清理未知在原记录中保留。

## 完整原始 Native 预算

| 窗口 | Native / bundled | Web / hosted |
| --- | ---: | ---: |
| 完整普通登录 | **361 = 19 + 13 + 329** | **412 = 19 + 0 + 393** |
| 原始第一对启动 | **179** | **201** |

同一份原始 lifecycle JSON 分别由取证代理和根代理独立复算：12 checkpoints、8 segments、4 totals 共 24 记录；每条 17 operation 桶、78 source 桶；1153 条 query ordinal 与实际 scope 全部守恒。保留全部邮件认证、PKCE、自动导航、后台和原始首对窗口，unknownReadings=0。

诊断仍为 incomplete。未知 context/statement 分别是 Native 91/118、Web 87/139、bundled 53/70、hosted 48/79；overflow=false。查询计数完整不等于每条请求或语句都已经归因。

Native physical/logical starts=14/36，Web=35/35；首对 bundled=6/19、hosted=18/18。Native issues.syncIssueList 和 hosted coordinator.syncCoordinatorChat 各有一条跨终点请求，之后实际返回 200。原边界不移动，完成计数不改写。

相对旧 f886，Native logical 41→36：四个命名动作各 4→3，旧 null-action 401 本轮未出现。完整 action/segment/status 对照保留；这里没有把减少的查询全归因于代码修复。

## 功能、清理与资源

Lifecycle 8、smoke 10、parity 100 captures、三独立进程 crypto/package 均通过。五对启动的原始中位数为 1970.81/2144.56ms；SQL 验收仍取第一对。实际安装 daemon 是 0.0.551 / facb389f6cc06c453e9135bb60ada1b0f302e0d9，不能当成本 PR 新生产 daemon。

lifecycle 的 owner/peer 基线 before=false/false，smoke before=true/true，after 均 true/true；两份 workspaceNameCleanup.restored 都仍是 false。parity restored=true。正常 cleanup stages、native resources cleaned 和 lease released 与这些字段分别保留。

Image 使用 31 条 synthetic replies，不是真实订阅；六容器、三卷、一网络 Removed。四 PG 的容器/网络已在 CP21 闭合；companion 五 PG 容器/四网络有删除回显，少数 mac LaunchAgent/SSH fixture 缺独立关闭回执的边界明确保留。

唯一取证 VM 已 stopped + deleted + exact resume=false GET404。实际 219102ms、CPU8798ms，网络入/出14946886/361965B；没有延长、没有模型或应用重跑。费用未计算，不写成零。

## 下一步与保留边界

main 已推进到854（#1773），10 个变化路径与本方 33 路径无直接交集，源码兼容性核查另存；本包不把后续组合源码标为已由本次 Native 检验。合并前重新核实际 main、review、生产 writer 和有界账户段，普通 merge 保全他方修改。

PostHog 真实 session 到手后使用单数 session-recording-get 按 UUID 读取；必要的精确列表查询可显式 filter_test_accounts=false。metadata 存在不证明渲染，官方资料也未保证 bot 标记在服务端永不被拒绝。实际 PNG、Replay 渲染、完整链路/生成计数、Notebook、最终受控失败与开销仍待生产执行。

全部先前失败与旧来源证据保留。前序完整索引：[Checkpoint 21](https://github.com/alexj11324/Mikka/blob/fe81d04de2c6938b5dc866312b0f3163b69d2b7a/docs/operations/evidence/1512-raw/replay-opt-in-025118ed-20261109/index.safe.json)。
