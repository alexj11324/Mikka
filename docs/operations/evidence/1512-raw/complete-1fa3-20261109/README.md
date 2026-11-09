# #1512 — 当前 PR 完整 CI 与 Native 证据（Checkpoint 20）

本 checkpoint 的源码门禁全部通过，生产 ACME 验收仍为 **0**；#1512 保持开放。

## 不可变来源

- PR #1799 head：`1fa3becd9b69e27c7a0229762750b6fa7e9497fc`
- CI：[`42564360573`](https://github.com/alexj11324/Mikka/actions/runs/42564360573)，2026-11-09 05:29:57 UTC 完成，success。
- 实际 checkout：`f8864eb83055504ac445e07e8d94a0e8eabedee9`；tree `0ecc16ec86a3650f85170f46bc4b996700c420d8`，与 PR head 的 tree 相同。
- head 的 43 个 check runs：36 success、7 个原有条件 skip；没有失败或运行中的 check。另 9 个伴随 workflow 均 success。
- 历史 CP18/CP19、旧 Native RED、独立 C 超时和旧生产发布失败均保留，不用本轮通过覆盖它们。

## 本轮完成的源码验证

Core 57、Integration 29 与实际 selection 完全一致。Daemon 1572 passed / 2 existing skips；138 个文件 passed / 1 个既有文件 skipped。四个 PostgreSQL shard 共 72 suites、3780 个 Node 报告的 tests，0 fail/skip/cancel/todo；四个容器及四个网络已实际移除。

Canonical routes generator --check、类型检查、代码及运行时规则、protocol、mobile、Node 18/22 mac package 均通过。A+B 13/13、C32=16+11+5、runs/repos 各 2 SQL、enrollment/pending 原路径 4→1、10 个并发 fence 的 round trips 11→6 已归档。Factory activity 45/45、HTTP 7/7、actor 57 也在当前实际选集中。

生产 daemon image 验证 job 使用隔离的 31 条 synthetic responses；本轮同源码 daemon、packaged login/chat/live/restart 均通过。六个容器、三个 volume、一个 network 已 Removed。PR 的 publish 为原条件 skip，这不是已发布生产 daemon 的证明。Browser gate 只执行 gate echo；DB aggregate 的旧名称也不构成真实浏览器验收。

## 原始 Native 窗口

| 原始窗口 | Native / bundled | Web / hosted |
|---|---:|---:|
| 普通完整登录 | **396 = 19 + 15 + 362** | **414 = 19 + 0 + 395** |
| 第一对启动 | **181** | **199** |

保留原 runner、完整邮件认证、PKCE、自动导航、后台流量与第一对启动，没有缩短窗口或扣除流量。12 checkpoints + 8 segments + 4 totals 共 24 条记录的 17 operation buckets 与 78 nested source buckets 守恒。Root 从相同原始 lifecycle blob 独立重新计算，所有标量及 bucket delta、各段之和、单调计数器、1190 个诊断 ordinal 连续性及 scope bucket 对账均通过。

完整登录 physical/logical：Native **17/41**、Web **35/35**；第一对启动为 **7/19** 与 **19/19**。相对 CP18 的 Native logical 40，本轮唯一额外记录是 `/api/desktop/rpc` 的 `rpcAction=null`、HTTP401，发生在 common-email-authentication 原段，started/completed 各一次。其余 40 个具名 logical action 的次数不变。401 仍在原预算内，无法从该证据识别其预期业务 action。

Query diagnostics 仍为 **incomplete**：Native unknown context/statement **94/134**、Web **85/145**、bundled **53/71**、hosted **48/76**。原始计数器 unknownReadings=0、overflow=false、dropped=0 与归因 unknown 是不同字段。

Lifecycle 8、smoke 10、parity 50 screens × 2 themes、三次独立 crypto/package 验证均通过。五对冷启动中位数为 2451.36 / 2607.57 ms，没有新加验收阈值。实际安装 daemon 是 **0.0.551 / facb389f6cc06c453e9135bb60ada1b0f302e0d9**，不代表本次 daemon 已生产发布。

## 清理与文字更正

Lifecycle 的 owner/peer sealed baseline 均为 before=false、after=true、changedTableCount=1；smoke 的两身份均为 true→true、changedTableCount=0。CP18 README 曾把 smoke 的 before 值合写错，独立 addendum 更正这句话；原始 JSON 与 cleanup receipts 一直正确且不改写。

原 lifecycle **workspaceNameCleanup.restored=false** 被明确保留。它与最终 owner/peer sealed baseline 匹配是独立字段，不能把后者转写为 restored=true。

取证 VM `issue1512-native-1fa3-20261109-0532` 于 05:41:43.331 UTC 停止、删除，05:42:04 exact project/name readback 返回 404 not_found。实际运行 609011ms、active CPU 6942ms、ingress 15006236B、egress 318552B；不声称实际账单为零。本 checkpoint 时所有自有临时取证 VM 均已关闭。

## 公开数据边界

原始日志保留返回的 UTF-8、BOM 与 ANSI。唯一例外是 analytics job 128988531408：公开副本将源码已有的 public capture key 精确出现 10 次替换为固定标记；文件名明确为 capture-key-redacted，原始与公开副本的各自 bytes/hash 均保留。它不被标作逐字原件。PG1 的一个邮箱形状命中是同源 synthetic fixture，公开说明不重复邮箱值。

真实 Native PNG 的 read_file 能力检查返回截断 base64、没有 ImageContent；这不是像素验收。ZIP bytes/SHA/完整性、310 个 artifact 文件的清单、五个原 JSON、两份原 Native/UI 日志及独立复算脚本均可审查。

## 当前 main 与后续生产

main 02401458 的三个 MCP paths 已与 PR 相同，其余八条路径与本 PR 的 25 条 owned paths 不相交。准备的联合 tree `fa800b0e41446e7d479473ee3db8e6a1e22e341c` 保留双方变化；该对象未改 ref，且**未运行联合源码 CI**。实际合并仍须重新读取 main/head、review/checks 与有效 owner 发布窗口。

本 checkpoint 包含生产 driver 的参数与清理准备、14 项精确元数据查询及二次稳定对账的已有 helpers 指纹，以及 Replay Vision 的有界执行配方；这些准备文件没有执行任何生产 ACME 样例、Vision 扫描或 native PostHog 导出。后续必须绑定实际发布源码、实际两模型 run/session/trace、全部 generation、原生 PNG、真实 Replay render、Logs、Notebook、受控失败、性能和清理后，才能关闭 #1512。
