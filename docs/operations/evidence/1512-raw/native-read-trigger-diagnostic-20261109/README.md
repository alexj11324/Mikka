# CP51：Native 读取触发诊断源码、首轮 preflight OOM 与入口关闭

## 正式结论没有改变

固定业务 PR #1799 仍为 `d2c3f63448130443e3e10bb5304417162f585776`。该源码功能 CI 成功，但正式 Native 完整登录窗口 **424 > Web 358，FAIL +66**；原 FIRST pair 1 为 **211 ≤ 221，PASS**。正式生产仍 **0/2**，当前不可关闭 #1512，也不能用本诊断支持合并。

本 checkpoint 保存临时观察层、精确 patch、独立与 Root 审阅、执行控制器，以及实际发布、首轮失败和旧入口关闭的时间线。**诊断首轮在 renderer typecheck 阶段 V8 堆 OOM，未进入 PG、构建、打包或应用 Native 验收，未取得新预算。**这不是已证明的 TypeScript 诊断或产品缺陷。后续 6GB 内存配置仅为另一次准备，不在此包内声明第二 run 已创建或通过。

## 固定源码与父链

| 角色 | Commit | Tree / 父 |
| --- | --- | --- |
| 原失败业务源码 | `d2c3f63448130443e3e10bb5304417162f585776` | tree `a311b73945e9846a33a2bbd3ffa54b9e23888b1d` |
| 临时观测 S | `668f1a3543f8d007d0b1cae655a2595c1cfa657f` | tree `5a72ec243b49bf7c0547f97d2b636938afe1ee3a`，唯一 parent d2c |
| 执行 R | `dc32133ba6d2db3303365bfa9e360fbc487ea0b5` | tree `10b9ce122ca7e390bcc525b255174dde7c17ffd5`，唯一 parent S |

S 仅 8 路径：6 个既有文件加入观察、2 个新诊断文件。归档者逐字核对这 8 个源码 blob、字节数和 SHA256，并核其与 source manifest、Root 完整 S 树差分、执行 manifest 一致。Root 的既有独立回执证明其余 6,834 叶不变并重算全部 874 个目录；此处复用该回执，不冒称再次执行产品代码。

R 仅在 S 上新增固定 workflow 与单次 execution manifest。原 source PR/main 未由本归档操作改动。8 份源码完整保存在 `sources/<原路径>`，模式均为 100644。

## 实际发布、首轮终态与入口关闭

| 时间（UTC，2026-11-09） | 已发生事实 | 固定原件 |
| --- | --- | --- |
| 23:23:05 / 23:23:10 | run queued / job queued；不据 queued 的 started_at 推断 runner 已工作 | `publication/runner-publication.safe.json` |
| 23:24:30 | Root 观察到 job in_progress，runner 已分配，实际 start 23:23:15；source/request guard 成功，pnpm install 在跑，PG pending | `publication/root-in-progress-232430.safe.json` |
| 23:26:58 | 首 run / 唯一 job 自然 terminal FAILURE，renderer tsc V8 OOM、exit 134 | `terminal/first-run-terminal.safe.json` |
| 23:30:47 / 23:30:57 | 旧入口禁用后的 job / run terminal skipped，runner id/name 为 null，steps=[] | `terminal/old-entry-disabled.safe.json` |

首轮为 [run 42719996457 / attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42719996457)，唯一 job `129511219631`，head 为 R。配置 job timeout 60 分钟、acceptance timeout 30 分钟；它在 typecheck 提前结束，不把预算上限当实际运行时间。

实际失败命令为 `tsc --noEmit -p tsconfig.renderer.json`。原件中 V8 堆观测约 2,055 MiB，进程 exit 134；**没有观测到 TypeScript 报告的编译错误**。同一步的两个 `node --check` 位于 tsc 之前，bash 已进入后续 tsc；没有独立命令级报告。排在 tsc 后的 runtime YAML parse 未执行。PG/build/package/acceptance 均 skipped，artifact 数为 0，提取 VM 为 0。

`terminal/job-129511219631.original.log` 与 `terminal/job-129511219631.wrapper.json` 由唯一原件 reader `/root/native_diag_runner` 一次读取后冻结。本归档仅复用 Git 原件，并独立确认 plain 与 wrapper 的 `structuredContent.content` 逐字相等；没有再访问 Actions 原日志或 ZIP。

`terminal/pg-cleanup.no-start.safe.json` 是唯一 reader 从 stdout 恢复的 canonical 476B JSON，SHA256 与 stdout 中 audit SHA 一致；它不是下载的 artifact。真实字段为 `postgresStepOutcome:"skipped"`、`observation:"no_owned_start_intent_observed"`、`ownedStartRequested:false`、`stopRequested:false`、`passed:true`。这表示未观察到本轮自有 PG 启动 intent，**不能称为实际 PG 停止已验证**。

旧入口 `ops/1512-native-read-diagnostic-20261109` 随后由原 owner 正常关闭：关闭 head `e78648e6f10ee87e99012021466d2171f319865c`，tree `08909070902fe48e1da4813007c47b388c835a81`，唯一 parent 为 R；manifest `62b70c359102ee298fcbf7e1dce2284ed33dd57a` 的 `enabled=false`。由该关闭提交产生的 [run 42721038256 / attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42721038256)、job `129514766916` 直接 skipped、未分配 Mac runner。它不是首轮重跑，也不是应用清理执行。

queued / running / 未发布准备的旧原件全部原样保留，只作为各自时间快照；本 README 与 index 的最终状态以首轮终态和入口关闭回执为准。归档者没有追加 job 轮询或发起运行。

## 已有验证的精确范围

源码 manifest 记录 **纯 V8 13 项 checks，通过 13、失败 0**：使用实际导出函数与轻量适配，覆盖闭集验证、真实 ISO 形状、晚安装与 sealed/tail 等边界；不是 Node、Playwright、Chromium、CDP 或 Mac 的实际运行证明。曾有 TextEncoder/URL 的宿主限制，原回执明确保留，未伪装成产品结果。

runner v2 cleanup proof 包含 **6 项合成 PostgreSQL 清理场景**，包括无自有 intent、缺失/无效 intent、停止成功/未确认等控制分支；使用合成执行器，**不是实际 PostgreSQL 服务、连接或机器的清理实测**。两类验证分别保留，不能相加成某次实际 PG/Mac 测试总数。

v1 runner preparation 原件保留为 historical / superseded，其中的旧 workflow 和“未发布”状态只代表其原时间。当前采用 v2 workflow `97ff3aacdea495d930e015c0616403d66db55cb6`、manifest `24d12e18a4d8a0b9d0c0ff818afa7e009c29c595` 、两份早期 publication/checkpoint、首轮终态和旧入口关闭回执；不改写历史记录。

## 观察范围与不可消除的未知

1. **初始 Native attachmentLate。** Native 首文档可能早于 firstWindow 返回及观察器安装，page.attachmentLate 与 document.late 分别保留；不能因为后续文档正常就伪称完整捕获。没有 cold FIRST capture。
2. **丢失、遗漏和未封口。** other 值、非法包、缺 key/scope/entity/reference/action、本地 ID 省略、序列缺口/重复、sink 失败、pending delivery、unsealed/late document、缺 setup/snapshot 都保留 incomplete。合法报告可以不完整。
3. **尾部事件不改变预算。** capture 覆盖 attachment 到普通 context close，可能有原登录预算窗口外的 tail。新 product sequence 会清除旧 sealed，不能用早期 snapshot 封口后来事件；更不能把 tail 从原预算中扣除或塞回。
4. **CPU / IPC 扰动。** retained rows/bytes 与身份表有上限；每事件 CPU 和 IPC 交付发生在原窗口内，其总工作量没有同等上限。因此不能把诊断耗时或 SQL 数字直接解释为正式产品性能。
5. **跨层关联仍有限。** document UUID、performance.timeOrigin、CDP loader/request 的局部身份分列，不造同一 ID。无原 user/workspace/entity/SWR key、请求 header/body、URL query 或服务端 invocation ID；时间与 action 近似不能证明参数相同、同一请求或重复 SQL。
6. **预算与业务行为不变。** 原 readBoundary/current/accepts/applied/cache 判断、授权、dispatch、全部窗口起止和 checkpoint、selector/fixture/usable、FIRST 和清理顺序保留。既有产品调用不增加 DB 查询、应用 API 请求或 readBoundary；sink 不增加 timer、轮询或遥测网络出口，但诊断开销必须诚实保留。

同轮 +66 原件证明 email 19=19、Native handoff/自动 renderer 15 对 Web DOM 0、workspace-to-usable 390 对 339。具名 RPC 净 +39、其他已知 HTTP context 净 +7、unknown context 净 +20；这些是已观测分解，仍不能给额外读取轮次命名源码因果。原 unknown 不扣除、不填零。

## 文件与完整性

本包 **32 个 payload，1125394 B**，加 README 与总索引共 **34 个文件**。

- `proofs/`：11 份冻结原件，含同轮差额、source manifest、exact patch、独立/Root review、workflow/manifest、v2 cleanup、v1 历史准备、R readback 和 23:00 共享发布快照。
- `sources/`：8 个最终源码原 blob，保留原相对路径。
- `publication/`：2 份实际发布与 Root in_progress 历史快照。
- `terminal/`：5 份首轮 terminal、原 plain/wrapper、stdout 恢复的 no-start cleanup，以及旧入口关闭回执。
- `public/`：PR #1799、#1512、#1752 的 4 条正文原字节及其读取时间/URL 回执；其中 #1752 保存 22:51:43 修正版，23:24:30 运行中评论保留其历史含义。
- `integrity.safe.json`：输入哈希、8 路径映射、plain/wrapper 配对、状态时间线、闭集隐私扫描和归档动作边界。

完整 path/mode/blob/bytes/SHA256 在 [index.safe.json](index.safe.json)。26 份冻结输入均逐字读取 Git 并校验；已有原件不重新序列化。没有重复下载 CP50 的 CI 原日志或 Native ZIP。归档提交单父接 CP50，只追加本目录，原有 8,767 叶须全部保持不变，最后仅正常 CAS evidence 分支并回读。

本归档者启动 workflow、VM、测试、账号或模型均为 0；source/main/ops ref 写入、PR/issue 评论均为 0。新内存 runner 及后续实际结果留下一 checkpoint。**本包终态为首轮诊断 preflight OOM、入口已关闭、无应用测量；正式结论仍为 d2c 完整 Native FAIL、FIRST 单对 PASS、生产 0/2。**
