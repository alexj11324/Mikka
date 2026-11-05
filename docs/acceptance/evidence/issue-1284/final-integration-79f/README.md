# Issue #1284：最终整合验收证据

本包最终受测提交为 `79f56a4f3362067b22f1919af51ee1869f3bb86c`，树为 `26cf764fb87bb7b6e549b4d421113626b8bc497e`，正常合并父为 `77bba5ab…` 与 `08b11f0d…`。本包保存 Docker 隔离环境中的实际构建、正常账号 HTTP、截图、门禁和清理记录；不代表真实生产 CC/Codex 订阅已验收完成。

## 实际执行与版本

| 证据 | 实际版本及结果 |
| --- | --- |
| [79f 构建与 HTTP 收据](79f/receipt.json) | 完整 `pnpm build` 于 12:25:53.613–12:29:14.235 UTC 执行一次，exit 0；真实 Next 监听后严格 attestation；新的普通 TestAccountPool 注册/登录会话完成 61/61 HTTP 断言。 |
| [79f 逐项 HTTP 结果](79f/http-61.json) | Profile CRUD/版本/权限 27 项，无 Run 的 Review 恢复 24 项，picker 正常 GET 与隔离边界 10 项。没有调用真实模型，没有新增原生 Run。 |
| [77b 构建与 HTTP 收据](77b/receipt.json) | 此前 77b 独立完整构建通过，61/61 HTTP 与 8 张实际页面截图完成。该记录保留原版本，不改标为 79f。 |
| [截图及实际 DOM 观察](77b/visual/capture-receipt.json) | 77b 实际 1440×1000、390×844，浅/深色各两帧（选择 checking、展开菜单），共 8 张。正常账号 storageState 只在同 Docker 内由 Chromium 使用；未点 Create/Send/Retry，未运行浏览器测试套件。 |
| [79f 截图复用依据](79f/visual-reuse.json) | 600 个 UI 及相关依赖 blob、lockfile 与 77b 逐字相同。79f 没有重新截图；原像素、时间和来源保持 77b。 |
| [最终合并交点门禁](79f/main08b-gates-58.json) | 实际本地 46560 检查点（与公开 79f 同树）完成 58/58：23 单元、35 PG；0 fail/skip。 |
| [Stop 25 项](source/stop-25-receipt.json) | 保留实际 c717/908 来源。原直接导入 policy 模块的命令只算 import smoke；真正 policy audit 另由 [dbcd 收据](source/run-chain-dbcd-receipt.json)记录。 |
| [严格测试适配](source/stop-control-fixture-receipt.json) | 实际 dbcd 加单个测试 adapter 补丁，默认 33/33、flags 23/23；不改产品权限。发布后的 [947 CI](ci/runtime947.json)另有独立证据。 |
| [79f CI](ci/batch79f.json) | 31 个终态检查：26 success、5 conditional skip。旧 [77b CI](ci/batch77b.json)保留原版本。 |

图中的 checking Profile 可以正常选择，提示为中性状态，创建按钮启用；已停用 Profile 与 enabled 但 `noModels` 的 Profile 均显示为不可选。界面观察来自实际截图；`aria-disabled`、按钮状态及布局宽度来自 capture receipt 的 DOM 读取。root 和独立 reviewer 的图像复核均由 assistant 执行，不是 Alex 的人工验收。

## 保留的准备失败

[77b 首轮结果](77b/http-attempt1-60-incomplete.json)为已执行 60/60 通过、overall false、0 张截图。截图脚本错误使用 `section=all`，实际应用回到 Coordinator；随后账号 hold 到期，按正常流程 quarantine/release，valid sessions 为 0。原始 `failure.step` 保留最后记录的成功 peer 检查名称，该检查本身 `passed=true`；这不是 peer 权限隔离失败。

第二次 capture 曾在 DOMContentLoaded 后过早点击尚未交互就绪的按钮，没有打开 dialog。正常页面在 networkidle 后同一按钮可打开真实 dialog，placeholder 未改，page errors 为空。修正仅限捕获脚本的正确路由与就绪条件；[导航修正](harness/capture-navigation-fix.json)、[就绪修正](harness/capture-hydration-fix.json)及[最终捕获脚本](harness/capture-final.mjs)均保留。新官方租约上的 77b 完整 61 项及 8 图随后完成。

## 清理与证据边界

77b 与 79f 的账号均正常 release/quarantine，valid sessions 为 0；两组独立 Task/Issue/Run 及合成 catalogue 已正常清理。各自 Next/controller 停止、3110 关闭，所属数据库在 0 connections/active leases 条件下正常 DROP，角色删除；没有 FORCE、终止他人会话或修改生产数据库。私有审计上下文只保留在 Docker 内，供官方 `auditEvidence` 扫描本包；审计报告在候选目录外，绑定逐文件清单的 SHA-256。

用户本次明确排除的是未充值的 DeepSeek 编码 API 路径；这不禁止产品内置 Decision。本包隔离验收也未调用任何真实外部模型 API。本地产品 HTTP API 的 61 项断言确实执行，两者不是同一概念。本包没有真实 CC/Codex 原生模型执行，也不将 synthetic catalogue、pending 重试回执或截图认作生产订阅通过。

此前已冻结并独立审计的 20 文件证据保留在 [dce91050 的不可变索引](https://github.com/alexj11324/Mikka/blob/dce91050e494b8012f01218ffab84c44740acea5/docs/acceptance/evidence/issue-1284/prebuild-recovery-20261105/README.md)，本包不重写其字节或版本。

收据中的原执行 `/tmp` 或相对日志路径及哈希用于追溯，不表示这些原始日志包含在本包。
