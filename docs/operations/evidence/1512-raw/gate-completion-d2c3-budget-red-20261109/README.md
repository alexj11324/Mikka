# CP50：d2c3 功能 CI 收口，Native 完整预算仍为 RED

## 当前结论

本 checkpoint 记录固定候选 `d2c3f63448130443e3e10bb5304417162f585776` 的真实结果，**不是可合并或完成 #1512 的声明**。

- 功能 CI：精确 HEAD 的 12 个 workflow 均 completed / success。
- Native 完整登录窗口：**424 > 358，FAIL，差额 +66**。
- 原 FIRST pair 1 启动窗口：**211 ≤ 221，PASS**；首对通过不能代替完整窗口。
- 正式生产验收：**0/2**。PostHog 实际双模型链路、Logs、PNG、Replay 与最终生产结论不在本 checkpoint 中判通过。
- 原件取件 VM 已停止、删除并对同 project/name 获得精确 404；自有资源为 0。归档者未创建任何资源。

## 固定来源

| 字段 | 精确值 |
| --- | --- |
| PR | #1799 |
| 候选 head | `d2c3f63448130443e3e10bb5304417162f585776` |
| 实际 CI checkout | `3bc095c100537563296186fc3d4cc4d60b59b698` |
| 产品 tree | `a311b73945e9846a33a2bbd3ffa54b9e23888b1d` |
| 主 CI | run 42707256422 / attempt 1 |
| Native job | 129474527225，success，2026-11-09 22:28:28 UTC 完成 |
| strict job | 129484343677，success，2026-11-09 22:28:42 UTC 完成 |
| evidence 父提交 | `b84d9728f806087c93e7d2dc4e28bab475135219`（CP49） |

元数据中的 job.head_sha 指候选 head；实际 checkout 由既有原件及 source-binding 证明，不能互相替代。新批次 62 的同内容证明单列保存，不把包装提交解释为本次另一次 CI 或 Native 执行。

## 全量元数据闭合

本次读取精确 head 的 workflow-runs、每个 run 的 attempt-1 jobs、`filter=all` check-runs、check-suites 和 commit statuses。所有响应均用每页 100 条并对照 total_count，完整数量分别为 12 / 45 / 46 / 19，commit statuses 首页面为空。没有使用混入旧 suite 的 latest 汇总计数。

- **45 个 Actions job：37 success，8 skipped。** 八个原条件跳过分别为 E2B validate/check/subscriptions/await-web/cleanup/publish、Device gateway deploy、主 CI Cloud credential access (OIDC)。跳过不证明生产发布、模型调用或清理执行。
- **46 个 check-run：38 success，8 skipped。** 其中 45 个 ID 与 Actions job 一一精确对应；额外一个 GitGuardian Security Checks（129467171549）真实 success。
- **19 个 check-suite：13 success，6 UNKNOWN。** 后六个为 queued、conclusion=null、check 数为 0 的第三方 suite：cursor、claude、kiro-agent、devin-ai-integration、vercel、boxes-dev。不能写成所有 suite PASS。
- 所有本次 Actions workflow/job 已终态；所有 run 均 attempt 1，没有把旧 attempt 结果说成新执行。
- 从 Root 已冻结 strict Git 原件独立核得 7 个 EXPECT=true，并逐项对应 CORE/INTEGRATION/SOURCE/DAEMON/IMAGE/DESKTOP/ANALYTICS=success。

精确 job/check/suite ID、URL、步骤、时间和分页终止依据在 [metadata/final-ci-metadata.safe.json](metadata/final-ci-metadata.safe.json)。元数据功能成功不覆盖 Native 数字预算失败。

## 保存的原件

共 **60 个 payload，15951196 B**，另加本说明及总索引，共 **62 个文件**。完整 path/blob/mode/bytes/SHA256 在 [index.safe.json](index.safe.json)。

| 子目录 | 件数 | 内容 |
| --- | ---: | --- |
| source/ | 10 | 原 index、Source/Core/PG3/PG4 的 4 plain + 4 wrapper、独立执行 proof；保留原 ci-d2c3 相对结构 |
| native/ | 21 | 原 index、20 payload，包含原 README、5 JSON、唯一 Native 原日志、316 项 archive manifest、窗口与 RPC 守恒、资源清理 |
| proofs/ | 10 | Root Native 独算、新旧差分、UI 执行、Daemon/Custody、selection、Integration、Offline/DBsummary、batch62 同内容及两份共享发布观察 |
| root-originals/ | 14 | Changes/Integration/Daemon/Offline E2B/Custody/DBsummary/strict 的原 plain + wrapper |
| metadata/ | 1 | 本次完整、安全、精确 HEAD 元数据 |
| public/ | 3 | PR #1799 在 22:44:22 的正文原字节、#1512 comment 6753484456 原字节、只读来源回执 |
| integrity.safe.json | 1 | 既有 55 文件逐字节校验、11 对 plain/wrapper 一致、闭集隐私扫描与原件边界 |

所有既有正文以原 blob 挂入，没有重排 JSON、删字段或重算旧报告。Source owner 确认其包没有另一个遗漏 README；Native 原 README 明确包含。这里只复用已冻结 Git 原件，没有下载任何原 Actions 日志或 ZIP。

## Native 数字与清理边界

Root 独算与唯一 Native reader 的 24 records / 12 checkpoints / 8 segments / 2280 桶 / 1214 ordinals 一致，守恒 0 错、预算 1 错。完整值为 Native 19+15+390=424、Web 19+0+339=358。四窗 crossStart/crossEnd/uncaptured 均为 0；原 unknown context 71/91/53/53 和 statement 107/129/76/71 保留，未扣除或回填。

完整旧新差分在 proofs/ 中保存。差分事实不自行证明某个产品改动的因果，也不以 FIRST、功能 job 成功或新包装 tree 等价抵销完整预算 RED。历史更早预算仍保持原结论。

取件 VM 22:34:27.098 UTC 停止，实际 wall 189291 ms、active CPU 6214 ms；删除后同项目/名称 GET404 已由唯一 reader 保存。费用金额 unknown，不记为零。业务/模型调用和本次归档资源创建均为 0。

## UI 执行与覆盖边界

Integration15 的 agent-ui-report 14 个、Integration21 的 settings-sections 10 个及 retry-reply-button 34 个固定源标题，各恰好一次 PASS，共 58 个唯一记录。这不是整个 Integration 的测试总数。

board-view-state 的 4 个与 issue-workspace-settings 的 10 个源标题在本日志中未执行：`test:view-state` 不在该次执行命令中。它们是 not-executed-by-this-log，不能写成 skip 或通过，也不据此新增门禁。静态渲染 / happy-dom 测试不等于 hosted 生产 DOM；Native 实际 settings/parity 另按自己的原件判断。

## 归档操作边界

本提交仅追加当前 CP50 证据目录，单父普通提交接 CP49，并以 expected_sha / force:false 更新 evidence/1512-observability。未改 source、main、产品 ref、PR 或 issue，也没有测试、模型、生产任务、VM 或手动重跑。公开正文快照中的历史“当前”只适用于其原时间；本 checkpoint 的结论始终是：**功能 CI success，Native 完整 FAIL，生产 0/2，issue 未完成。**
