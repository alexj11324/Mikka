# Issue #1284 — 864113b 本轮增量证据

本包受测提交为 `864113bdb9a62dcff633c9ce7bc0fd59d93a6641`，Git tree 为 `579f791c9d5493dd46421350a7d86ec380ad1fe4`。它不是合并后的生产 main SHA，也不表示 Claude Code / Codex 的真实生产验收已全部完成。

本包只新增这一轮的整合、构建、HTTP、八张实际页面截图与清理证据。[此前 77b / 79f 的 37 件不可变证据](https://github.com/alexj11324/Mikka/blob/63c634cba20e6bf3d7544c19a57ba3edaa1d3bca/docs/acceptance/evidence/issue-1284/final-integration-79f/README.md)保持原版本、原结果和原失败记录，本包未重新打包或重标那些文件。

## 本轮结果与来源

| 项目 | 实际结果 | 版本与证据 |
|---|---|---|
| 完整 production build | `pnpm build` exit 0；2026-11-05T13:26:30.221Z → 2026-11-05T13:29:43.471Z | 实际公开提交 864113b；[完整摘要](qa/receipt.json) |
| 严格环境校验 | `http://localhost:3110`；2026-11-05T13:29:47.143Z ready；strict attestation、clean source | 正常 fresh schema / descriptor，实际 Next 服务；未重绑定旧 descriptor |
| 正常账号 HTTP | 61 / 61；2026-11-05T13:30:26.627Z 完成 | 官方 TestAccountPool 正常注册/登录，Owner / peer / anonymous；[原始断言收据](qa/http-result.json) |
| 本版本实际截图 | 8 张，0 张复用；2026-11-05T13:30:01.281Z → 2026-11-05T13:30:19.149Z | 1440×1000 / 390×844，浅色 / 深色，各含 checking 已选与菜单展开两帧；[采集收据](visual/capture-receipt.json)、[图片哈希](visual/visual-manifest.json) |
| 必要整合回归 | 207 / 207，0 skip | 15 Profile unit、11 React、50 Profile PG、48 dispatch PG、33 strict、23 flags strict、2 live PG、25 Stop PG；实际 local `1a0ad661…` 与公开 864113b 同 tree，未冒称在另一个 SHA 重跑；[收据](source/integration-gates.json) |
| exact-head CI | 31 项终态：26 success、5 conditional skip | workflow `42035590585` completed / success；[GitHub 读取收据](ci/current-head.json) |
| 本轮资源清理 | 预览停止、3110 关闭；账号租约释放；有效 sessions、所属数据库、角色均为 0 | 2026-11-05T13:32:49.100922+00:00 观察；正常 DROP，无 FORCE / terminate；[独立清理收据](qa/cleanup.json) |

HTTP 覆盖原有 27 项 Profile CRUD / 版本 / 权限、24 项未启动 Review 的普通 Owner retry 合同，以及 10 项真实 GET 支持的 picker 状态 / 隔离 / 无新增 Run 检查。HTTP 恢复 Task 和保留给视觉检查的 Task 是两个独立对象；未将前者的 pending 状态人工改回 blocked。

## 八张实际页面截图

采集沿正常账号会话打开 `section=all-issues`，等待真实页面就绪后打开“新建任务”。仅选择配置、填写未发送的合成说明和展开菜单；没有点击 Create / Send / Retry，没有运行浏览器测试套件。checking 的中性提示、菜单禁用属性与发送按钮状态的 DOM 记录属于采集收据；图片布局的独立观察属于两个 assistant 审阅，不是 Alex 或人工验收。

| 主题 / 视口 | checking 已选 | 菜单展开 |
|---|---|---|
| 浅色 1440 | [图片](visual/864113bdb9a6-profile-picker-selected-light-1440.png) | [图片](visual/864113bdb9a6-profile-picker-menu-light-1440.png) |
| 深色 1440 | [图片](visual/864113bdb9a6-profile-picker-selected-dark-1440.png) | [图片](visual/864113bdb9a6-profile-picker-menu-dark-1440.png) |
| 浅色 390 | [图片](visual/864113bdb9a6-profile-picker-selected-light-390.png) | [图片](visual/864113bdb9a6-profile-picker-menu-light-390.png) |
| 深色 390 | [图片](visual/864113bdb9a6-profile-picker-selected-dark-390.png) | [图片](visual/864113bdb9a6-profile-picker-menu-dark-390.png) |

[Root assistant 实际看图记录](visual/root-assistant-review.json)与[独立 assistant 看图记录](visual/independent-assistant-review.json)分别保留观察来源。菜单覆盖正文 / Create 是正常浮层；闭合的配对帧用于检查完整布局。截图不证明 live push、付费模型派单或原生 Review 已执行。

## 发布依赖修复与生产观察

[上游 main2e daemon 发布失败](source/upstream-main2e-daemon-failure.json)来自 API 1.10.0 与 core 2.12 的 peer 范围冲突。[精确 API 1.9.0 的红绿收据](source/daemon-dependency-receipt.json)记录真实发布依赖图的 install / shrinkwrap / SBOM / audit 检查及 23 项相关测试；实际本地生成包版本是 0.0.1，未执行 npm publish，也不冒称上游发布版本号。该修复源码 c932… 与公开 d3fa… 同 tree，已包含于本轮提交。

ALEX67 的[正常 Owner Retry 原始观察](production/retry-original.json)与[后续精确运行时归因补充](production/retry-runtime-addendum.json)必须一起读取：页面 / public 版本为 main64，但该次 Decision 被旧 08b 部署的现存 workflow 消费。补充日志给出 `uncertain_profile`、三个自有候选 available；没有暴露 confidence 或 selected ID。它不是 64 或 8641 源码真实执行失败的证据，更不是 Codex 订阅拒绝或原生 Review 已发生的证据。本批可按其完整门禁正常合并 / 部署已验证的 daemon、Stop、Profile 修复；dueTimer 的修复或迁移将另行 fix-forward，不在本包的测试范围内。Issue #1284 仍保持 open，真实生产闭环仍 pending。

## 验收边界与完整性

用户明确排除未充值的 DeepSeek coding API 路径；本轮隔离验收也未调用其他真实外部模型 API，未禁止产品内置 Decision。真实生产仍需分别观察独立 Review / Owner Accept、frontend 原生执行、显式选择与版本冻结，不能用本地 61 项或截图替代。

合成 Profile、catalogue 和两 Task 已清理，普通账号租约已正常释放 / quarantine，有效 sessions 为 0。只有官方静态审计需要的私有 context / ledger 留在 Docker 内部，没有导出密码、cookie、session token、DB URL 或签名密钥。PG 集群与共享沙盒留给另一项已授权的具体 dueTimer 调查，本包不声称它们已停止。

外部 manifest 对本目录每个文件记录字节数、SHA256 与 Git blob SHA1；官方 `auditEvidence` 报告放在目录外，并绑定这个 manifest 与本轮 fresh context。收据中的原执行日志位置 / 哈希是溯源信息，不承诺那些原始日志也在本包内。
