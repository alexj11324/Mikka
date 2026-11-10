# Issue #1329：按任务难度自动选模型验收记录

> 本文保留当次版本的三路模型证据与失败。现行验收使用共享 SMOKE 账号，
> 官方 Claude Code 与 Codex 两条订阅路径独立记录。DeepSeek/API-key 路径
> 已退出合并及验收门槛，后续执行按 [验收指南](../acceptance.md)。

日期：2026-11-05。关联 [issue #1329](https://github.com/alexj11324/Mikka/issues/1329) 与 [PR #1337](https://github.com/alexj11324/Mikka/pull/1337)。已实际验证的源码基线为 head `682c8fab7a12c8a77912b35beda8ad996f984f70`、tree `826c7f62fd6045a260dee5f95b0b8e73d14f0e87`。

**当前状态：`682c8fab` 的类型、lint、UI 与相关定向回归均通过，10 文件定向 DB 为 163/163，Large 完整生产构建成功，GitHub CI 的 8 项 workflow 均通过。该真实构建的 8 张截图已采集完成，全部浏览器诊断指标为 0，八张视觉复核均通过。真实服务验证保留明确的前置阻塞记录。**

## 已验证源码与后续整合范围

定向测试环境：Docker Medium `sbx_001m6myc5g6n531cbdjfk0686n6`，PostgreSQL 17 隔离数据库，Node.js 24.22.2、pnpm 10.34.3。执行记录 `proc-1793857660185831523-79`，退出码 0。

| 验证项 | `682c8fab` 源码结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| subscription-usability | 通过；包含按 Agent 分组、实时更新与自动路由保存/失败恢复的整合 |
| run-info | 通过；包含冻结路由展示和旧记录兼容 |
| execution-rules | 整套通过 |
| 10 文件定向 DB | 163 项、163 通过、0 失败、0 跳过；包含 4 个事务交叉回归及上游相关回归 |
| Large 完整 `pnpm build` | 通过，执行记录 `proc-1793857658531064238-44`，退出码 0 |

仓库完整门禁以 [GitHub CI 41976150906](https://github.com/alexj11324/Mikka/actions/runs/41976150906) 为准，`682c8fab` 的 8 项 workflow 已全部通过。以上 163 项是本次 10 文件定向 DB 回归，不代指仓库完整 DB 门禁。

随后整合主分支 `94f1b829`（#1351），无冲突。独立审查确认，该次整合未改变本功能的 17 个 UI、投影、路由与 claim 文件，以及全站 Web 组件和样式；交集仅为 `lib/coordinator/group-factory.ts`（发布报告后推送）和 `package.json`（测试 scripts）。

最终整合另包含 `7bf00995`（#1348）的默认 Profile 健康来源修复与回归用例。`agent-profile.ts` 的同一调用点保留两侧语义：仅显式指定模型时传入 picked 约束，同时继续传递难度路由上下文与 Decision 依赖，避免把只指定 Agent 的请求错误当作固定模型。相关 DB 与最终提交 CI 的结果在 PR 中记录。

两次整合均未改变截图对应的 Web 组件、样式或冻结字段投影。因此最终提交复用 `682c8fab` 的真实生产构建截图，仅覆盖同源的页面与投影呈现范围；截图的源码标识继续保留 `682c8fab`，不重标为后续提交，也不把截图当成后续 Profile 来源选择逻辑的运行证据。

## 生产构建截图与隔离数据读取

最终截图采集记录为 `proc-1793858239822864431-51`，退出码 0，8 张全部完成。实际生产构建源码为 `682c8fab7a12c8a77912b35beda8ad996f984f70`，绑定隔离数据库 `mikka_1329_release_e2e`、origin `http://localhost:3000` 与 descriptor `.cache/1329-release-environment.json`。下表全部为该构建新采集的图片；后续整合提交按前述同源范围复用，保留真实采集源码标识。

采集保留环境身份校验与全部浏览器错误检查，在字体及滚动完成后等待 650ms，让既有控件动画稳定；没有修改产品代码或放宽错误检查。首次尝试曾被旧服务身份不匹配拦住，生成 0 张图且未取得账号租约；停止经确认的旧服务进程后重新采集成功。

| 视口与主题 | 设置页 | 执行详情 |
| --- | --- | --- |
| 1440 × 1000，浅色 | [设置页](issue-1329-evidence/settings-light-1440.png) | [执行详情](issue-1329-evidence/details-light-1440.png) |
| 1440 × 1000，深色 | [设置页](issue-1329-evidence/settings-dark-1440.png) | [执行详情](issue-1329-evidence/details-dark-1440.png) |
| 390 × 844，浅色 | [设置页](issue-1329-evidence/settings-light-390.png) | [执行详情](issue-1329-evidence/details-light-390.png) |
| 390 × 844，深色 | [设置页](issue-1329-evidence/settings-dark-390.png) | [执行详情](issue-1329-evidence/details-dark-390.png) |

| 采集检查 | `682c8fab` 实际结果 |
| --- | --- |
| 横向溢出 | 8 张均为 0 |
| `pageErrors` / `consoleErrors` / `http5xx` | 0 / 0 / 0 |
| `blockedOrigins` / `originFenceFailures` | 0 / 0 |
| 隔离 fixture 清理 | `cleanupComplete=true` |
| 账号租约 | `leaseState=quarantined` |
| 审计 | 通过 |

设置页四图已逐张视觉复核通过：「按任务难度自动选模型」开关、标签与模型列表完整可读，桌面行内排列与手机纵向排列间距正常，无截断或横向溢出。浅色手机图的「优先使用的 Agent」选中背景位于 Claude Code 按钮内，描述末行完整，未再出现动画遮挡。

执行详情四图已逐张视觉复核通过：冻结的难度、模型、推理强度与原因在 1440 / 390 视口、明暗主题下均完整可读；手机布局自适应且无横向溢出，对话框长内容正常内部滚动。

owner 读取执行证据返回 HTTP 200，冻结的 routing 内容与预期逐项一致；peer 读取同一记录返回 HTTP 404。截图和权限读取使用隔离 fixture，只证明页面呈现、冻结数据投影与 owner 隔离正确，不计为真实模型执行。

## 专项与修正前史

此前模型路由纯函数 18 项、路由 dispatch 12 个子场景、设置真实 DB 均通过；Factory suite 为 459 项，458 通过、1 跳过；Provider 恢复 22 个场景及已发布 daemon 0.0.456 兼容验证通过。Telemetry 抛错回归通过：协调下一阶段失败后仍记录一次冻结结果，运行中及其他 owner 不记录，并发重放和后续恢复不重复。

此前的 108/111/141 项定向 DB 结果已由 `682c8fab` 的 163/163 结果取代；首轮旧 Agent Profile 调用计数与旧版 daemon 字段解析的夹具断言问题已修复，不属于待完成项。

## 真实服务验证：阻塞，未计为通过

| 路径 | 实际观察 | 执行结果 |
| --- | --- | --- |
| API `deepseek-flash` | 仅核验余额接口：`available=false`，余额 CNY -0.01 | 跳过模型请求；未验证具体 Flash 版本 |
| 官方 Claude Code `claude-haiku-5-5` | 本次隔离验收环境的登录状态为 false | 阻塞，未发起真实模型请求 |
| 官方 Codex `gpt-6-luna` | 本次隔离验收环境显示 `Not logged in` | 阻塞，未发起真实模型请求 |
| local-loop | 依赖的 DeepSeek 当前不可用 | 未运行 |

三路分别记录阻塞，没有改用替代服务发请求。Claude Code 和 Codex 的未登录仅指本次隔离验收环境，不代表 Alex 的生产账号未登录。这些结果仅证明前置条件不足，不能作为真实模型执行或升级重试的成功证据。

## 合并与发布证据

最终整合提交的 GitHub CI、合并提交、部署 READY 与正式域名版本，以及只读页面/API 核验结果，追加在本文件顶部关联的 PR 和 issue 中，以其精确提交关联的记录为准。

本 issue 的生产数据只读，不安排生产账号任务写入。上述真实服务与 local-loop 阻塞是本次验证的已知范围，未计为通过；记录不包含凭据或个人账号信息。
