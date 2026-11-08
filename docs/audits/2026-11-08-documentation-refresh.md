# 全仓文档审校记录

这份记录供 Mikka 维护者核对 2026-11-08 的文档更新范围、源码依据和验证边界。
本次逐项审阅 **386 份第一方 Markdown 文档**，其中 **142 份有改动**。
本文件也计入第一方文档数。每个文件的处理结果列在清单中。

## 版本与口径

源码基线为 `420b1ebe15a8364bed8b626713029601852fb80a`。完整审阅先在
`095e3971133e20006fea500fe977ac73bf206ec5` 上进行，再逐项复核两者之间的
源码、文档和决定差异。更新通过 [PR #1756](https://github.com/alexj11324/Mikka/pull/1756)
交付，任务为 [#1755](https://github.com/alexj11324/Mikka/issues/1755)。

清单覆盖 `git ls-files '*.md' '*.mdx'` 中的第一方内容，包括 `docs/`、根目录、
应用和包的 README、Agent 示例、脚本指南、模板与历史证据。仓库中的 HTML 文件是
运行时页面和截图工具的应用入口。八张 README SVG 按对应生成脚本重新生成，
另列在验证范围中。

`.claude/` 下另有 **223 份第三方 Markdown**。既有正文保持原样，两个新增文档
skill 的正文、七个参考文件和 MIT 许可证按固定上游版本核对。来源与归属见
[skill 索引](../../.claude/skills/README.md)。

## 审阅结果

本次按文档承担的任务逐项处理。现行指南对照源码修正，已接受的决定保留原话与日期，
过时方案增加后续决定或实现边界，历史验收保留原始版本、失败和测量结果。

| 范围 | 审阅文件 | 本次改动 |
| --- | ---: | ---: |
| 设计指南 | 43 | 39 |
| 决定、调研与设计历史 | 196 | 20 |
| 开发、运行与运维 | 26 | 22 |
| 后端与设置契约 | 34 | 22 |
| Factory、验收与历史证据 | 53 | 20 |
| 移动端、Worker 与归属声明 | 4 | 4 |
| 中英文项目 README | 2 | 2 |
| 仓库、包与工具入口 | 23 | 10 |
| 审校期间主分支新增文档 | 4 | 2 |
| 本次审校记录 | 1 | 1 |
| 合计 | 386 | 142 |

主要修正涵盖以下内容。

- Vite、Hono、Nitro 的开发、构建与发布入口，桌面更新和 daemon 的更新责任。
- 任务列表、任务内的线程与多次尝试、状态图标、原生移动端和 UI slot 的实现范围。
- 模型和机器选择、订阅凭据托管、taskSecret 交付、隔离账号分配与租约。
- Factory 的独立审查、按交付契约要求的检查、验收和发布。
- 到期 timer、Worker 定期补查、Linear 开关状态、共享生产 smoke 的真实覆盖。
- 已接受的 coding-review 方案与部分前端实现的差异，以及后端端点和运行时验收的证据要求。

设计与决定依据见 [设计入口](../design/README.md)、[术语](../design/glossary.md)、
[规则](../design/rules.md) 和 [决定索引](../design/decisions/README.md)。
运行与测试依据包括 `package.json`、`apps/api/scripts/`、`scripts/start-app.mjs`、
`scripts/test-accounts/`、`.github/workflows/`、`packages/daemon/src/`、
`packages/subscription-worker/`、`lib/secrets/`、`lib/factory/` 和 `lib/linear-sync/flags.ts`。

## 验证记录

- `git diff --check` 通过。
- 对第一方 Markdown 的仓库相对链接和标题锚点逐项解析，未发现缺失目标或锚点。
- `node --test scripts/ci-docs-only.test.mjs scripts/vercel-ignore-build.test.mjs` 的 16 个测试通过。
- 两个图表生成脚本的 Node 语法检查通过。八张 SVG 可重复生成并通过 XML 解析。
  人工查看了架构图和任务流程图的中英文、明暗主题四张代表性渲染。
- 两个新增 skill 保留固定上游正文和 MIT 归属。冻结决定日志的原始记录、历史原始证据
  和第三方许可证按原有语义及字节要求保留。
- 独立设计、技术文档和 JavaScript 复审覆盖实际修改，发现的状态色、历史审计措辞、
  试用额度归属、账号复用、工作树描述和 Linear 状态问题已修正。

CI 分类器为四个已维护的文字指南增加精确路径，继续排除运行时 Agent 指令、其他脚本、
可执行模式、符号链接和子模块。分类器修改使用可信基线的正常 CI，当前 PR 需要完整检查。
合并状态和 Git 关联的 CI 结果以 PR 页面为准。

## 保留的证据边界

本轮验证是文档、源码和文档工具的一致性审校。既有验收报告中的生产、OAuth、
真实订阅调用、原生设备和性能结论继续绑定各自记录的版本与环境。外部调研引用保留
原始访问日期。私有 UI layer、Figma 接受状态与部署开关需要其各自的版本证据。

本次识别的实现差距保留在相应现行指南中，包括 `test:local-loop` 的 DeepSeek 限制及
源码指纹遗漏 `apps/`、旧 observability driver 的账号契约、coding-review 后端端点的
待实现状态。后续实现由对应任务交付。

## 逐项清单

“更新”表示相对上述源码基线产生文档改动。“保留”表示全文审阅后保持原有内容。
已接受的方案、历史报告、测试说明和运行时指令按其用途保留。

| 文件 | 用途分类 | 处理 |
| --- | --- | --- |
| [.claude/skills/README.md](<../../.claude/skills/README.md>) | 现行指南与参考 | 更新 |
| [.github/pull_request_template.md](<../../.github/pull_request_template.md>) | 模板与指令 | 保留 |
| [.github/workflows/README.md](<../../.github/workflows/README.md>) | 现行指南与参考 | 更新 |
| [AGENTS.md](<../../AGENTS.md>) | 现行指南与参考 | 更新 |
| [CONTRIBUTING.md](<../../CONTRIBUTING.md>) | 现行指南与参考 | 更新 |
| [README.md](<../../README.md>) | 现行指南与参考 | 更新 |
| [README.zh-CN.md](<../../README.zh-CN.md>) | 现行指南与参考 | 更新 |
| [REVIEW.md](<../../REVIEW.md>) | 现行指南与参考 | 保留 |
| [agents/README.md](<../../agents/README.md>) | 现行指南与参考 | 更新 |
| [agents/research-example/instructions.md](<../../agents/research-example/instructions.md>) | 模板与指令 | 保留 |
| [agents/research-example/skills/source-checking/SKILL.md](<../../agents/research-example/skills/source-checking/SKILL.md>) | 模板与指令 | 保留 |
| [apps/desktop/README.md](<../../apps/desktop/README.md>) | 现行指南与参考 | 更新 |
| [apps/desktop/test/native-document-probe.md](<../../apps/desktop/test/native-document-probe.md>) | 现行指南与参考 | 保留 |
| [apps/desktop/test/native-frame-probe.md](<../../apps/desktop/test/native-frame-probe.md>) | 现行指南与参考 | 保留 |
| [apps/mobile/DESIGN.md](<../../apps/mobile/DESIGN.md>) | 现行指南与参考 | 更新 |
| [apps/mobile/README.md](<../../apps/mobile/README.md>) | 现行指南与参考 | 更新 |
| [docs/README.md](<../../docs/README.md>) | 现行指南与参考 | 更新 |
| [docs/acceptance.md](<../../docs/acceptance.md>) | 现行指南与参考 | 更新 |
| [docs/acceptance/2026-11-03-device-gateway-reliability.md](<../../docs/acceptance/2026-11-03-device-gateway-reliability.md>) | 历史记录 | 保留 |
| [docs/acceptance/2026-11-04-issue-1212/approved-write-live.md](<../../docs/acceptance/2026-11-04-issue-1212/approved-write-live.md>) | 历史记录 | 保留 |
| [docs/acceptance/2026-11-04-issue-1212/computer-events-checkpoint.md](<../../docs/acceptance/2026-11-04-issue-1212/computer-events-checkpoint.md>) | 历史记录 | 保留 |
| [docs/acceptance/2026-11-04-issue-1212/pending-actions-live.md](<../../docs/acceptance/2026-11-04-issue-1212/pending-actions-live.md>) | 历史记录 | 保留 |
| [docs/acceptance/issue-1225/question-wake-review.md](<../../docs/acceptance/issue-1225/question-wake-review.md>) | 历史记录 | 更新 |
| [docs/acceptance/issue-1296-chat-balance.md](<../../docs/acceptance/issue-1296-chat-balance.md>) | 历史记录 | 保留 |
| [docs/acceptance/issue-1296-production-followup.md](<../../docs/acceptance/issue-1296-production-followup.md>) | 历史记录 | 更新 |
| [docs/acceptance/issue-1296-ui-audit.md](<../../docs/acceptance/issue-1296-ui-audit.md>) | 历史记录 | 更新 |
| [docs/acceptance/issue-1329-model-routing.md](<../../docs/acceptance/issue-1329-model-routing.md>) | 历史记录 | 更新 |
| [docs/acceptance/issue-1415/README.md](<../../docs/acceptance/issue-1415/README.md>) | 历史记录 | 更新 |
| [docs/acceptance/issue-1415/final-evidence.md](<../../docs/acceptance/issue-1415/final-evidence.md>) | 历史原始证据 | 保留 |
| [docs/acceptance/issue-1415/final-report.md](<../../docs/acceptance/issue-1415/final-report.md>) | 历史记录 | 保留 |
| [docs/acceptance/issue-1415/native-parity-7973-5c0b605a.md](<../../docs/acceptance/issue-1415/native-parity-7973-5c0b605a.md>) | 历史记录 | 保留 |
| [docs/acceptance/issue-1415/runtime-performance.md](<../../docs/acceptance/issue-1415/runtime-performance.md>) | 历史记录 | 更新 |
| [docs/acceptance/issue-1415/web-parity-6149-7973.md](<../../docs/acceptance/issue-1415/web-parity-6149-7973.md>) | 历史记录 | 保留 |
| [docs/acceptance/issue-1593.md](<../../docs/acceptance/issue-1593.md>) | 历史记录 | 保留 |
| [docs/acceptance/personal-mailbox-core/verification-evidence.md](<../../docs/acceptance/personal-mailbox-core/verification-evidence.md>) | 历史记录 | 保留 |
| [docs/acceptance/project-map-cold-read-cost-20261105.md](<../../docs/acceptance/project-map-cold-read-cost-20261105.md>) | 历史记录 | 保留 |
| [docs/acceptance/self-hosted-batch/enabled-models-api.md](<../../docs/acceptance/self-hosted-batch/enabled-models-api.md>) | 现行指南与参考 | 保留 |
| [docs/acceptance/self-hosted-batch/status.md](<../../docs/acceptance/self-hosted-batch/status.md>) | 历史记录 | 保留 |
| [docs/architecture/coordinator-streaming.md](<../../docs/architecture/coordinator-streaming.md>) | 现行指南与参考 | 更新 |
| [docs/architecture/native-coordinator.md](<../../docs/architecture/native-coordinator.md>) | 历史记录 | 保留 |
| [docs/audits/2026-11-03-factory-continuity-1160-1161.md](<../../docs/audits/2026-11-03-factory-continuity-1160-1161.md>) | 历史记录 | 保留 |
| [docs/audits/2026-11-04-shared-mcp-1163.md](<../../docs/audits/2026-11-04-shared-mcp-1163.md>) | 历史记录 | 保留 |
| [docs/audits/2026-11-05-collapsed-error-codes.md](<../../docs/audits/2026-11-05-collapsed-error-codes.md>) | 历史记录 | 保留 |
| [docs/audits/2026-11-08-documentation-refresh.md](<../../docs/audits/2026-11-08-documentation-refresh.md>) | 本次审校记录 | 更新 |
| [docs/audits/proactive-1157-1163/replay-comparison-v2.md](<../../docs/audits/proactive-1157-1163/replay-comparison-v2.md>) | 历史记录 | 保留 |
| [docs/backend/131-site-search.md](<../../docs/backend/131-site-search.md>) | 历史记录 | 更新 |
| [docs/backend/179-conversation-schedules.md](<../../docs/backend/179-conversation-schedules.md>) | 实施与运行参考 | 更新 |
| [docs/backend/308-approved-writes-browser.md](<../../docs/backend/308-approved-writes-browser.md>) | 实施与运行参考 | 更新 |
| [docs/backend/credential-vault.md](<../../docs/backend/credential-vault.md>) | 实施与运行参考 | 更新 |
| [docs/backend/device-ssh-install.md](<../../docs/backend/device-ssh-install.md>) | 实施与运行参考 | 更新 |
| [docs/backend/hosted-abuse-controls.md](<../../docs/backend/hosted-abuse-controls.md>) | 实施与运行参考 | 更新 |
| [docs/backend/issue-numbering.md](<../../docs/backend/issue-numbering.md>) | 实施与运行参考 | 保留 |
| [docs/backend/personal-submission-contract.md](<../../docs/backend/personal-submission-contract.md>) | 实施与运行参考 | 更新 |
| [docs/ci/1699-results.md](<../../docs/ci/1699-results.md>) | 历史记录 | 保留 |
| [docs/ci/incremental.md](<../../docs/ci/incremental.md>) | 现行指南与参考 | 保留 |
| [docs/cloud-preview.md](<../../docs/cloud-preview.md>) | 现行指南与参考 | 更新 |
| [docs/cloud-services-api.md](<../../docs/cloud-services-api.md>) | 实施与运行参考 | 保留 |
| [docs/coordinator-issue-mutations.md](<../../docs/coordinator-issue-mutations.md>) | 实施与运行参考 | 更新 |
| [docs/design/README.md](<../../docs/design/README.md>) | 现行指南与参考 | 更新 |
| [docs/design/agent-as-code.md](<../../docs/design/agent-as-code.md>) | 现行指南与参考 | 更新 |
| [docs/design/auth-email-recovery.md](<../../docs/design/auth-email-recovery.md>) | 现行指南与参考 | 更新 |
| [docs/design/brand.md](<../../docs/design/brand.md>) | 已接受规范 | 更新 |
| [docs/design/chat-attachments.md](<../../docs/design/chat-attachments.md>) | 已接受规范 | 更新 |
| [docs/design/chat-tool-calls.md](<../../docs/design/chat-tool-calls.md>) | 已接受规范 | 更新 |
| [docs/design/cloud-computer-backend.md](<../../docs/design/cloud-computer-backend.md>) | 历史记录 | 更新 |
| [docs/design/components.md](<../../docs/design/components.md>) | 现行指南与参考 | 更新 |
| [docs/design/copy.md](<../../docs/design/copy.md>) | 现行指南与参考 | 更新 |
| [docs/design/credential-vault.md](<../../docs/design/credential-vault.md>) | 历史记录 | 更新 |
| [docs/design/daemon-connection.md](<../../docs/design/daemon-connection.md>) | 现行指南与参考 | 更新 |
| [docs/design/decisions.md](<../../docs/design/decisions.md>) | 冻结决定历史 | 更新 |
| [docs/design/decisions/2026-10-30-2307-acceptance-is-the-merge.md](<../../docs/design/decisions/2026-10-30-2307-acceptance-is-the-merge.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-0011-recording-step-timeline.md](<../../docs/design/decisions/2026-10-31-0011-recording-step-timeline.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-0055-merge-states-in-decision-bar.md](<../../docs/design/decisions/2026-10-31-0055-merge-states-in-decision-bar.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1730-decision-records.md](<../../docs/design/decisions/2026-10-31-1730-decision-records.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1803-coordinator-openui-prompt.md](<../../docs/design/decisions/2026-10-31-1803-coordinator-openui-prompt.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1805-menu-icons-search-composer.md](<../../docs/design/decisions/2026-10-31-1805-menu-icons-search-composer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1814-segmented-control-motion.md](<../../docs/design/decisions/2026-10-31-1814-segmented-control-motion.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1834-every-bot-replies.md](<../../docs/design/decisions/2026-10-31-1834-every-bot-replies.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1840-figma-through-composio.md](<../../docs/design/decisions/2026-10-31-1840-figma-through-composio.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1937-apps-in-device-runs.md](<../../docs/design/decisions/2026-10-31-1937-apps-in-device-runs.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-1952-app-page-details.md](<../../docs/design/decisions/2026-10-31-1952-app-page-details.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2005-desktop-update-button.md](<../../docs/design/decisions/2026-10-31-2005-desktop-update-button.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-10-31-2010-ota-updates.md](<../../docs/design/decisions/2026-10-31-2010-ota-updates.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-10-31-2048-beui-native.md](<../../docs/design/decisions/2026-10-31-2048-beui-native.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2105-mobile-image-cards.md](<../../docs/design/decisions/2026-10-31-2105-mobile-image-cards.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2110-bots-reply-on-mikka-cloud.md](<../../docs/design/decisions/2026-10-31-2110-bots-reply-on-mikka-cloud.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2130-personal-vs-workspace.md](<../../docs/design/decisions/2026-10-31-2130-personal-vs-workspace.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-10-31-2200-mobile-native-ios.md](<../../docs/design/decisions/2026-10-31-2200-mobile-native-ios.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2200-run-machine-fallback.md](<../../docs/design/decisions/2026-10-31-2200-run-machine-fallback.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2200-subscription-rows.md](<../../docs/design/decisions/2026-10-31-2200-subscription-rows.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2225-bindings-belong-to-the-person.md](<../../docs/design/decisions/2026-10-31-2225-bindings-belong-to-the-person.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2300-orchestration-spec.md](<../../docs/design/decisions/2026-10-31-2300-orchestration-spec.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2330-bot-model-picker.md](<../../docs/design/decisions/2026-10-31-2330-bot-model-picker.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-10-31-2345-mobile-bot-home.md](<../../docs/design/decisions/2026-10-31-2345-mobile-bot-home.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0015-main-is-the-design.md](<../../docs/design/decisions/2026-11-01-0015-main-is-the-design.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0030-mobile-reactions.md](<../../docs/design/decisions/2026-11-01-0030-mobile-reactions.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0045-mobile-home-bar.md](<../../docs/design/decisions/2026-11-01-0045-mobile-home-bar.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0050-mobile-chat-settings.md](<../../docs/design/decisions/2026-11-01-0050-mobile-chat-settings.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0110-agent-mark-on-threads.md](<../../docs/design/decisions/2026-11-01-0110-agent-mark-on-threads.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0230-browser-tests-manual-only.md](<../../docs/design/decisions/2026-11-01-0230-browser-tests-manual-only.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0300-agents-inject-test-logins.md](<../../docs/design/decisions/2026-11-01-0300-agents-inject-test-logins.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0303-github-plugin-connection-separate-from-login.md](<../../docs/design/decisions/2026-11-01-0303-github-plugin-connection-separate-from-login.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0330-ui-figma-and-skill-review-before-code.md](<../../docs/design/decisions/2026-11-01-0330-ui-figma-and-skill-review-before-code.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0338-github-plugin-page.md](<../../docs/design/decisions/2026-11-01-0338-github-plugin-page.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0400-hosted-calls-run-concurrently.md](<../../docs/design/decisions/2026-11-01-0400-hosted-calls-run-concurrently.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md](<../../docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-0400-research-before-asking-alex.md](<../../docs/design/decisions/2026-11-01-0400-research-before-asking-alex.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1144-board-done-keeps-its-width.md](<../../docs/design/decisions/2026-11-01-1144-board-done-keeps-its-width.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1152-payment-card-row-and-credit-shares.md](<../../docs/design/decisions/2026-11-01-1152-payment-card-row-and-credit-shares.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1155-stop-a-bot-reply.md](<../../docs/design/decisions/2026-11-01-1155-stop-a-bot-reply.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1200-own-e2b-key-is-enough-for-cloud.md](<../../docs/design/decisions/2026-11-01-1200-own-e2b-key-is-enough-for-cloud.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1201-e2b-template-public-auto-release.md](<../../docs/design/decisions/2026-11-01-1201-e2b-template-public-auto-release.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1204-type-follows-comma.md](<../../docs/design/decisions/2026-11-01-1204-type-follows-comma.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1215-push-by-github-app.md](<../../docs/design/decisions/2026-11-01-1215-push-by-github-app.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1215-star-is-the-pin.md](<../../docs/design/decisions/2026-11-01-1215-star-is-the-pin.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1230-mikka-object-chips-are-boxed.md](<../../docs/design/decisions/2026-11-01-1230-mikka-object-chips-are-boxed.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1230-network-open-by-default.md](<../../docs/design/decisions/2026-11-01-1230-network-open-by-default.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1240-rail-icons-only.md](<../../docs/design/decisions/2026-11-01-1240-rail-icons-only.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1250-five-thread-groups.md](<../../docs/design/decisions/2026-11-01-1250-five-thread-groups.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-01-1300-decision-api-decides-suggestions.md](<../../docs/design/decisions/2026-11-01-1300-decision-api-decides-suggestions.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1300-no-workspace-name-in-breadcrumbs.md](<../../docs/design/decisions/2026-11-01-1300-no-workspace-name-in-breadcrumbs.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1310-every-divider-resizes.md](<../../docs/design/decisions/2026-11-01-1310-every-divider-resizes.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1310-no-ask-for-app-granted-abilities.md](<../../docs/design/decisions/2026-11-01-1310-no-ask-for-app-granted-abilities.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1312-cloud-runs-without-docker.md](<../../docs/design/decisions/2026-11-01-1312-cloud-runs-without-docker.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1320-navigation-model.md](<../../docs/design/decisions/2026-11-01-1320-navigation-model.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-01-1330-one-thread-per-task.md](<../../docs/design/decisions/2026-11-01-1330-one-thread-per-task.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1330-write-judgment-unavailable-goes-ahead.md](<../../docs/design/decisions/2026-11-01-1330-write-judgment-unavailable-goes-ahead.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1400-pushes-and-briefing-decided-by-decision-api.md](<../../docs/design/decisions/2026-11-01-1400-pushes-and-briefing-decided-by-decision-api.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1410-one-task-one-sandbox.md](<../../docs/design/decisions/2026-11-01-1410-one-task-one-sandbox.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1430-browser-has-no-ask.md](<../../docs/design/decisions/2026-11-01-1430-browser-has-no-ask.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1440-dev-workflow-local-first.md](<../../docs/design/decisions/2026-11-01-1440-dev-workflow-local-first.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1500-self-improvement-and-profile-decided-by-decision-api.md](<../../docs/design/decisions/2026-11-01-1500-self-improvement-and-profile-decided-by-decision-api.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md](<../../docs/design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1545-trunk-based.md](<../../docs/design/decisions/2026-11-01-1545-trunk-based.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1630-agent-mailbox-notifications.md](<../../docs/design/decisions/2026-11-01-1630-agent-mailbox-notifications.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1640-agent-mailbox-push.md](<../../docs/design/decisions/2026-11-01-1640-agent-mailbox-push.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-1700-computer-viewer-handoff.md](<../../docs/design/decisions/2026-11-01-1700-computer-viewer-handoff.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2220-threads-open-as-cards.md](<../../docs/design/decisions/2026-11-01-2220-threads-open-as-cards.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md](<../../docs/design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2230-nothing-on-bot-avatars.md](<../../docs/design/decisions/2026-11-01-2230-nothing-on-bot-avatars.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2240-own-credentials-always-usable.md](<../../docs/design/decisions/2026-11-01-2240-own-credentials-always-usable.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2245-thread-privacy-and-local-isolation.md](<../../docs/design/decisions/2026-11-01-2245-thread-privacy-and-local-isolation.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2250-default-first-usable-machine.md](<../../docs/design/decisions/2026-11-01-2250-default-first-usable-machine.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2255-library-delete-own-files.md](<../../docs/design/decisions/2026-11-01-2255-library-delete-own-files.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2300-thread-visibility-follows-warp.md](<../../docs/design/decisions/2026-11-01-2300-thread-visibility-follows-warp.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md](<../../docs/design/decisions/2026-11-01-2310-personal-and-team-workspaces-apart.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-01-2320-panels-open-instantly.md](<../../docs/design/decisions/2026-11-01-2320-panels-open-instantly.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-01-2331-use-official-e2b-desktop.md](<../../docs/design/decisions/2026-11-01-2331-use-official-e2b-desktop.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-01-2335-e2b-official-templates.md](<../../docs/design/decisions/2026-11-01-2335-e2b-official-templates.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0203-personal-workspace-keeps-bots.md](<../../docs/design/decisions/2026-11-02-0203-personal-workspace-keeps-bots.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0216-personal-workspace-has-workspace-settings.md](<../../docs/design/decisions/2026-11-02-0216-personal-workspace-has-workspace-settings.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0220-every-thread-ends-in-the-composer.md](<../../docs/design/decisions/2026-11-02-0220-every-thread-ends-in-the-composer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0220-waiting-raises-a-hand.md](<../../docs/design/decisions/2026-11-02-0220-waiting-raises-a-hand.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0230-pr-badge-on-thread-cards.md](<../../docs/design/decisions/2026-11-02-0230-pr-badge-on-thread-cards.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0231-workspace-is-the-tenant.md](<../../docs/design/decisions/2026-11-02-0231-workspace-is-the-tenant.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0241-own-credential-apps.md](<../../docs/design/decisions/2026-11-02-0241-own-credential-apps.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0251-desktop-runs-get-their-own-machine.md](<../../docs/design/decisions/2026-11-02-0251-desktop-runs-get-their-own-machine.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0300-waiting-for-you-first.md](<../../docs/design/decisions/2026-11-02-0300-waiting-for-you-first.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0301-esc-in-a-thread-composer.md](<../../docs/design/decisions/2026-11-02-0301-esc-in-a-thread-composer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0302-assignee-me-filter.md](<../../docs/design/decisions/2026-11-02-0302-assignee-me-filter.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0303-unbuilt-settings-hidden.md](<../../docs/design/decisions/2026-11-02-0303-unbuilt-settings-hidden.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0310-all-threads-from-the-window-bar.md](<../../docs/design/decisions/2026-11-02-0310-all-threads-from-the-window-bar.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0330-computer-policy-gates-computer-tasks-only.md](<../../docs/design/decisions/2026-11-02-0330-computer-policy-gates-computer-tasks-only.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-0340-thread-badge-follows-its-group.md](<../../docs/design/decisions/2026-11-02-0340-thread-badge-follows-its-group.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-02-1030-model-lists-only-reported.md](<../../docs/design/decisions/2026-11-02-1030-model-lists-only-reported.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1050-desktop-lifecycle.md](<../../docs/design/decisions/2026-11-02-1050-desktop-lifecycle.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1055-all-threads-waiting-count.md](<../../docs/design/decisions/2026-11-02-1055-all-threads-waiting-count.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-02-1200-api-keys-own-group-and-provider-models.md](<../../docs/design/decisions/2026-11-02-1200-api-keys-own-group-and-provider-models.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1232-computer-policy-binds-agents-not-people.md](<../../docs/design/decisions/2026-11-02-1232-computer-policy-binds-agents-not-people.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1300-device-models-checked-against-account.md](<../../docs/design/decisions/2026-11-02-1300-device-models-checked-against-account.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1400-model-order-dispatch.md](<../../docs/design/decisions/2026-11-02-1400-model-order-dispatch.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1410-mobile-follows-system-appearance.md](<../../docs/design/decisions/2026-11-02-1410-mobile-follows-system-appearance.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1450-chat-failure-stays-under-message.md](<../../docs/design/decisions/2026-11-02-1450-chat-failure-stays-under-message.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1500-personal-first-team-needs-two.md](<../../docs/design/decisions/2026-11-02-1500-personal-first-team-needs-two.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1500-subscription-models-need-no-device-report.md](<../../docs/design/decisions/2026-11-02-1500-subscription-models-need-no-device-report.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1530-coordinator-routes-screen-work-to-its-desktop.md](<../../docs/design/decisions/2026-11-02-1530-coordinator-routes-screen-work-to-its-desktop.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1530-local-server-first.md](<../../docs/design/decisions/2026-11-02-1530-local-server-first.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1600-agents-use-own-github-credential.md](<../../docs/design/decisions/2026-11-02-1600-agents-use-own-github-credential.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1610-model-settings-r1-r5.md](<../../docs/design/decisions/2026-11-02-1610-model-settings-r1-r5.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1620-preset-keys-speak-both-protocols.md](<../../docs/design/decisions/2026-11-02-1620-preset-keys-speak-both-protocols.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1638-desktop-update-on-launch.md](<../../docs/design/decisions/2026-11-02-1638-desktop-update-on-launch.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1640-mobile-forced-update-at-launch.md](<../../docs/design/decisions/2026-11-02-1640-mobile-forced-update-at-launch.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1645-onboarding-bind-subscription.md](<../../docs/design/decisions/2026-11-02-1645-onboarding-bind-subscription.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1700-feature-switches-in-posthog.md](<../../docs/design/decisions/2026-11-02-1700-feature-switches-in-posthog.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1700-preferred-agent.md](<../../docs/design/decisions/2026-11-02-1700-preferred-agent.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1723-desktop-adds-this-computer.md](<../../docs/design/decisions/2026-11-02-1723-desktop-adds-this-computer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1730-coordinator-github-mcp.md](<../../docs/design/decisions/2026-11-02-1730-coordinator-github-mcp.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1830-extra-usage-does-not-disable-subscriptions.md](<../../docs/design/decisions/2026-11-02-1830-extra-usage-does-not-disable-subscriptions.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1830-preferred-models-and-agent.md](<../../docs/design/decisions/2026-11-02-1830-preferred-models-and-agent.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1840-own-task-results-return-to-bot.md](<../../docs/design/decisions/2026-11-02-1840-own-task-results-return-to-bot.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1845-platform-tools-reach-saved-definitions.md](<../../docs/design/decisions/2026-11-02-1845-platform-tools-reach-saved-definitions.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1900-openai-providers-without-responses.md](<../../docs/design/decisions/2026-11-02-1900-openai-providers-without-responses.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-1936-personal-credentials-without-sharing.md](<../../docs/design/decisions/2026-11-02-1936-personal-credentials-without-sharing.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-2016-reply-retry-alignment.md](<../../docs/design/decisions/2026-11-02-2016-reply-retry-alignment.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-2033-release-subscription-repairs-after-checks.md](<../../docs/design/decisions/2026-11-02-2033-release-subscription-repairs-after-checks.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-2058-composer-model-name-only.md](<../../docs/design/decisions/2026-11-02-2058-composer-model-name-only.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-02-2120-secrets-and-logins-in-settings.md](<../../docs/design/decisions/2026-11-02-2120-secrets-and-logins-in-settings.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-02-2330-cloud-first-dispatch.md](<../../docs/design/decisions/2026-11-02-2330-cloud-first-dispatch.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-0230-github-link-from-desktop.md](<../../docs/design/decisions/2026-11-03-0230-github-link-from-desktop.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-0300-github-link-loopback.md](<../../docs/design/decisions/2026-11-03-0300-github-link-loopback.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-0315-github-link-callback-origin.md](<../../docs/design/decisions/2026-11-03-0315-github-link-callback-origin.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-0415-all-dispatch-through-factory.md](<../../docs/design/decisions/2026-11-03-0415-all-dispatch-through-factory.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-0455-chat-quote-and-copy.md](<../../docs/design/decisions/2026-11-03-0455-chat-quote-and-copy.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1213-factory-commit-label.md](<../../docs/design/decisions/2026-11-03-1213-factory-commit-label.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1220-preserve-navigation-state.md](<../../docs/design/decisions/2026-11-03-1220-preserve-navigation-state.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1232-factory-runtime-environment.md](<../../docs/design/decisions/2026-11-03-1232-factory-runtime-environment.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1242-all-chat-attachments.md](<../../docs/design/decisions/2026-11-03-1242-all-chat-attachments.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1430-base-path-single-owner.md](<../../docs/design/decisions/2026-11-03-1430-base-path-single-owner.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md](<../../docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1437-required-app-refresh.md](<../../docs/design/decisions/2026-11-03-1437-required-app-refresh.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1515-official-documentation-priority.md](<../../docs/design/decisions/2026-11-03-1515-official-documentation-priority.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1535-daemon-update-and-login.md](<../../docs/design/decisions/2026-11-03-1535-daemon-update-and-login.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1535-pause-update-connections.md](<../../docs/design/decisions/2026-11-03-1535-pause-update-connections.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-1625-explicit-agent-environment-verification.md](<../../docs/design/decisions/2026-11-03-1625-explicit-agent-environment-verification.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-2030-device-push-gateway.md](<../../docs/design/decisions/2026-11-03-2030-device-push-gateway.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-03-2359-issue-owner-merges-and-accepts-in-production.md](<../../docs/design/decisions/2026-11-03-2359-issue-owner-merges-and-accepts-in-production.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-04-1520-code-diffs-use-pierre-diffs.md](<../../docs/design/decisions/2026-11-04-1520-code-diffs-use-pierre-diffs.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-1659-reply-trace.md](<../../docs/design/decisions/2026-11-04-1659-reply-trace.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-04-1720-factory-question-command-continuity.md](<../../docs/design/decisions/2026-11-04-1720-factory-question-command-continuity.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-2021-project-map-internal-data.md](<../../docs/design/decisions/2026-11-04-2021-project-map-internal-data.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-2105-reply-trace-in-order.md](<../../docs/design/decisions/2026-11-04-2105-reply-trace-in-order.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-04-2200-factory-flow-like-warp.md](<../../docs/design/decisions/2026-11-04-2200-factory-flow-like-warp.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-2220-task-circle-thread-bubble.md](<../../docs/design/decisions/2026-11-04-2220-task-circle-thread-bubble.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-2221-chat-tool-groups-and-citations.md](<../../docs/design/decisions/2026-11-04-2221-chat-tool-groups-and-citations.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-2230-design-review-checks.md](<../../docs/design/decisions/2026-11-04-2230-design-review-checks.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-04-2320-reuse-existing-components.md](<../../docs/design/decisions/2026-11-04-2320-reuse-existing-components.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-0040-ink-3-holds-contrast.md](<../../docs/design/decisions/2026-11-05-0040-ink-3-holds-contrast.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-0200-no-new-polling.md](<../../docs/design/decisions/2026-11-05-0200-no-new-polling.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-0330-error-causes.md](<../../docs/design/decisions/2026-11-05-0330-error-causes.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-0400-per-agent-model-lists.md](<../../docs/design/decisions/2026-11-05-0400-per-agent-model-lists.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-1230-ios-native-first.md](<../../docs/design/decisions/2026-11-05-1230-ios-native-first.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-1300-ios-no-drawer.md](<../../docs/design/decisions/2026-11-05-1300-ios-no-drawer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-1535-ios-openbot-architecture.md](<../../docs/design/decisions/2026-11-05-1535-ios-openbot-architecture.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-1615-desktop-bundled-renderer.md](<../../docs/design/decisions/2026-11-05-1615-desktop-bundled-renderer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-1632-no-vercel-preview.md](<../../docs/design/decisions/2026-11-05-1632-no-vercel-preview.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-2005-ios-push-drawer.md](<../../docs/design/decisions/2026-11-05-2005-ios-push-drawer.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-2010-ios-home-list-interactions.md](<../../docs/design/decisions/2026-11-05-2010-ios-home-list-interactions.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-2103-mobile-list-badges.md](<../../docs/design/decisions/2026-11-05-2103-mobile-list-badges.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-05-2205-drawer-native-surface.md](<../../docs/design/decisions/2026-11-05-2205-drawer-native-surface.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1200-ios-drop-drawer-comma-redesign.md](<../../docs/design/decisions/2026-11-06-1200-ios-drop-drawer-comma-redesign.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1300-ios-comma-tabs-accepted.md](<../../docs/design/decisions/2026-11-06-1300-ios-comma-tabs-accepted.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1400-task-short-titles.md](<../../docs/design/decisions/2026-11-06-1400-task-short-titles.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1540-thread-task-only-and-long-message-fold.md](<../../docs/design/decisions/2026-11-06-1540-thread-task-only-and-long-message-fold.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1600-blocked-board-column.md](<../../docs/design/decisions/2026-11-06-1600-blocked-board-column.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1615-mikka-task-numbers.md](<../../docs/design/decisions/2026-11-06-1615-mikka-task-numbers.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1615-thread-header-icons-and-artifact-button.md](<../../docs/design/decisions/2026-11-06-1615-thread-header-icons-and-artifact-button.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1640-model-routing-judges-tier-and-effort.md](<../../docs/design/decisions/2026-11-06-1640-model-routing-judges-tier-and-effort.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md](<../../docs/design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-06-1900-desktop-sign-in-returns-to-the-app.md](<../../docs/design/decisions/2026-11-06-1900-desktop-sign-in-returns-to-the-app.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-2000-hosted-ui-overlay.md](<../../docs/design/decisions/2026-11-06-2000-hosted-ui-overlay.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-2000-local-device-node22.md](<../../docs/design/decisions/2026-11-06-2000-local-device-node22.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-06-2300-desktop-connects-to-self-hosted-servers.md](<../../docs/design/decisions/2026-11-06-2300-desktop-connects-to-self-hosted-servers.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-07-0325-no-silent-page-refresh.md](<../../docs/design/decisions/2026-11-07-0325-no-silent-page-refresh.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-07-1400-production-acceptance-scope.md](<../../docs/design/decisions/2026-11-07-1400-production-acceptance-scope.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-07-2045-tasks-only-threads-inside.md](<../../docs/design/decisions/2026-11-07-2045-tasks-only-threads-inside.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-07-2230-one-icon-per-task-state.md](<../../docs/design/decisions/2026-11-07-2230-one-icon-per-task-state.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-07-2300-one-conversation-per-task.md](<../../docs/design/decisions/2026-11-07-2300-one-conversation-per-task.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-08-0120-ios-header-like-comma.md](<../../docs/design/decisions/2026-11-08-0120-ios-header-like-comma.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-08-0130-task-state-icon-colours.md](<../../docs/design/decisions/2026-11-08-0130-task-state-icon-colours.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-08-0200-mobile-spacing.md](<../../docs/design/decisions/2026-11-08-0200-mobile-spacing.md>) | 已接受决定 | 保留 |
| [docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md](<../../docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md>) | 已接受决定 | 更新 |
| [docs/design/decisions/2026-11-08-1230-coding-workspace.md](<../../docs/design/decisions/2026-11-08-1230-coding-workspace.md>) | 现行指南与参考 | 更新 |
| [docs/design/decisions/2026-11-08-1430-ios-chat-gestures-and-header.md](<../../docs/design/decisions/2026-11-08-1430-ios-chat-gestures-and-header.md>) | 现行指南与参考 | 保留 |
| [docs/design/decisions/README.md](<../../docs/design/decisions/README.md>) | 现行指南与参考 | 保留 |
| [docs/design/desktop-bundled-renderer.md](<../../docs/design/desktop-bundled-renderer.md>) | 现行指南与参考 | 更新 |
| [docs/design/factory-agent-profiles.md](<../../docs/design/factory-agent-profiles.md>) | 已接受规范 | 保留 |
| [docs/design/glossary.md](<../../docs/design/glossary.md>) | 现行指南与参考 | 更新 |
| [docs/design/information-architecture.md](<../../docs/design/information-architecture.md>) | 历史记录 | 更新 |
| [docs/design/mcp-workspace-sharing.md](<../../docs/design/mcp-workspace-sharing.md>) | 现行指南与参考 | 更新 |
| [docs/design/mobile-comma-redesign.md](<../../docs/design/mobile-comma-redesign.md>) | 历史记录 | 更新 |
| [docs/design/mobile.md](<../../docs/design/mobile.md>) | 现行指南与参考 | 更新 |
| [docs/design/model-difficulty-routing.md](<../../docs/design/model-difficulty-routing.md>) | 已接受规范 | 保留 |
| [docs/design/onboarding.md](<../../docs/design/onboarding.md>) | 历史记录 | 更新 |
| [docs/design/orchestration.md](<../../docs/design/orchestration.md>) | 现行指南与参考 | 更新 |
| [docs/design/personal-plugins-backend.md](<../../docs/design/personal-plugins-backend.md>) | 现行指南与参考 | 更新 |
| [docs/design/platforms.md](<../../docs/design/platforms.md>) | 现行指南与参考 | 更新 |
| [docs/design/proactive.md](<../../docs/design/proactive.md>) | 提案 | 更新 |
| [docs/design/project-map-api.md](<../../docs/design/project-map-api.md>) | 现行指南与参考 | 更新 |
| [docs/design/project-map-rfc.md](<../../docs/design/project-map-rfc.md>) | 历史记录 | 更新 |
| [docs/design/research/2026-10-31-orchestration-conflicts.md](<../../docs/design/research/2026-10-31-orchestration-conflicts.md>) | 历史记录 | 保留 |
| [docs/design/research/2026-11-06-cloud-startup-production-baseline.md](<../../docs/design/research/2026-11-06-cloud-startup-production-baseline.md>) | 历史记录 | 保留 |
| [docs/design/research/chat-tool-calls-and-citations.md](<../../docs/design/research/chat-tool-calls-and-citations.md>) | 历史记录 | 保留 |
| [docs/design/rules.md](<../../docs/design/rules.md>) | 现行指南与参考 | 更新 |
| [docs/design/self-hosted-cloud-models.md](<../../docs/design/self-hosted-cloud-models.md>) | 实施与运行参考 | 保留 |
| [docs/design/self-hosting-cloud-client.md](<../../docs/design/self-hosting-cloud-client.md>) | 实施与运行参考 | 保留 |
| [docs/design/self-improvement-assignment-wiring.md](<../../docs/design/self-improvement-assignment-wiring.md>) | 历史记录 | 更新 |
| [docs/design/self-improvement-benchmark.md](<../../docs/design/self-improvement-benchmark.md>) | 现行指南与参考 | 更新 |
| [docs/design/self-improvement-live-acceptance.md](<../../docs/design/self-improvement-live-acceptance.md>) | 历史记录 | 更新 |
| [docs/design/self-improvement-skill-source-contract.md](<../../docs/design/self-improvement-skill-source-contract.md>) | 提案 | 更新 |
| [docs/design/self-improvement-validation.md](<../../docs/design/self-improvement-validation.md>) | 历史记录 | 更新 |
| [docs/design/self-improvement.md](<../../docs/design/self-improvement.md>) | 现行指南与参考 | 更新 |
| [docs/design/spec-template.md](<../../docs/design/spec-template.md>) | 模板与指令 | 更新 |
| [docs/design/subscription-execution-settings.md](<../../docs/design/subscription-execution-settings.md>) | 实施与运行参考 | 更新 |
| [docs/design/thread-execution-identity.md](<../../docs/design/thread-execution-identity.md>) | 现行指南与参考 | 更新 |
| [docs/design/thread-run-location.md](<../../docs/design/thread-run-location.md>) | 已接受决定 | 更新 |
| [docs/design/ui-consistency-audit.md](<../../docs/design/ui-consistency-audit.md>) | 历史记录 | 更新 |
| [docs/design/unattended-sandbox.md](<../../docs/design/unattended-sandbox.md>) | 已接受决定 | 更新 |
| [docs/design/versions.md](<../../docs/design/versions.md>) | 历史记录 | 更新 |
| [docs/design/web-group-create.md](<../../docs/design/web-group-create.md>) | 实施与运行参考 | 更新 |
| [docs/dev-workflow.md](<../../docs/dev-workflow.md>) | 现行指南与参考 | 更新 |
| [docs/execution-rules.md](<../../docs/execution-rules.md>) | 实施与运行参考 | 保留 |
| [docs/factory/1276-flow-v2.md](<../../docs/factory/1276-flow-v2.md>) | 现行指南与参考 | 更新 |
| [docs/factory/192-contract-v1.md](<../../docs/factory/192-contract-v1.md>) | 历史记录 | 更新 |
| [docs/factory/192-lifecycle-contract.md](<../../docs/factory/192-lifecycle-contract.md>) | 历史记录 | 保留 |
| [docs/factory/192-monitor-dispatch-v1.md](<../../docs/factory/192-monitor-dispatch-v1.md>) | 历史记录 | 保留 |
| [docs/factory/192-question-recovery-v1.md](<../../docs/factory/192-question-recovery-v1.md>) | 历史记录 | 保留 |
| [docs/factory/192-routing-main-contract.md](<../../docs/factory/192-routing-main-contract.md>) | 历史记录 | 更新 |
| [docs/factory/193-independent-checks.md](<../../docs/factory/193-independent-checks.md>) | 历史记录 | 更新 |
| [docs/factory/194-195-publication-handoff.md](<../../docs/factory/194-195-publication-handoff.md>) | 历史记录 | 更新 |
| [docs/factory/194-approval-contract-v1.md](<../../docs/factory/194-approval-contract-v1.md>) | 历史记录 | 更新 |
| [docs/factory/194-main-approval-v2.md](<../../docs/factory/194-main-approval-v2.md>) | 历史记录 | 保留 |
| [docs/factory/194-nonproduction-adapter.md](<../../docs/factory/194-nonproduction-adapter.md>) | 历史记录 | 更新 |
| [docs/factory/194-upstream-evidence.md](<../../docs/factory/194-upstream-evidence.md>) | 历史记录 | 更新 |
| [docs/factory/194-vercel-publication-v2.md](<../../docs/factory/194-vercel-publication-v2.md>) | 历史记录 | 保留 |
| [docs/factory/195-monitor.md](<../../docs/factory/195-monitor.md>) | 历史记录 | 保留 |
| [docs/factory/195-vercel-monitor-v2.md](<../../docs/factory/195-vercel-monitor-v2.md>) | 历史记录 | 保留 |
| [docs/factory/494-approve-and-publish.md](<../../docs/factory/494-approve-and-publish.md>) | 现行指南与参考 | 保留 |
| [docs/factory/backend-gaps-541.md](<../../docs/factory/backend-gaps-541.md>) | 现行指南与参考 | 保留 |
| [docs/factory/second-stage-simplification.md](<../../docs/factory/second-stage-simplification.md>) | 历史记录 | 保留 |
| [docs/factory/skill-semantic-assessment-contract.md](<../../docs/factory/skill-semantic-assessment-contract.md>) | 历史记录 | 保留 |
| [docs/factory/warp-aligned-factory.md](<../../docs/factory/warp-aligned-factory.md>) | 现行指南与参考 | 更新 |
| [docs/github-app-manifest.md](<../../docs/github-app-manifest.md>) | 实施与运行参考 | 更新 |
| [docs/infisical-cloud.md](<../../docs/infisical-cloud.md>) | 现行指南与参考 | 更新 |
| [docs/integration/agent-github-delivery-500.md](<../../docs/integration/agent-github-delivery-500.md>) | 现行指南与参考 | 更新 |
| [docs/issue-1372-acceptance.md](<../../docs/issue-1372-acceptance.md>) | 历史记录 | 更新 |
| [docs/issue-number-counter-rollout.md](<../../docs/issue-number-counter-rollout.md>) | 实施与运行参考 | 更新 |
| [docs/linear-sync.md](<../../docs/linear-sync.md>) | 实施与运行参考 | 更新 |
| [docs/local-bootstrap.md](<../../docs/local-bootstrap.md>) | 现行指南与参考 | 更新 |
| [docs/local-runtime.md](<../../docs/local-runtime.md>) | 现行指南与参考 | 更新 |
| [docs/mcp.md](<../../docs/mcp.md>) | 实施与运行参考 | 更新 |
| [docs/migration-bootstrap.md](<../../docs/migration-bootstrap.md>) | 现行指南与参考 | 更新 |
| [docs/operations/aws-kms-credential-setup.md](<../../docs/operations/aws-kms-credential-setup.md>) | 历史记录 | 更新 |
| [docs/operations/database-egress.md](<../../docs/operations/database-egress.md>) | 现行指南与参考 | 更新 |
| [docs/operations/desktop-docker-test-environment.md](<../../docs/operations/desktop-docker-test-environment.md>) | 现行指南与参考 | 更新 |
| [docs/operations/device-gateway-release.md](<../../docs/operations/device-gateway-release.md>) | 现行指南与参考 | 保留 |
| [docs/operations/group-decision-quality.md](<../../docs/operations/group-decision-quality.md>) | 现行指南与参考 | 更新 |
| [docs/operations/issue-1415-phase2-feasibility.md](<../../docs/operations/issue-1415-phase2-feasibility.md>) | 历史记录 | 更新 |
| [docs/operations/minute-worker-deployment.md](<../../docs/operations/minute-worker-deployment.md>) | 现行指南与参考 | 更新 |
| [docs/operations/model-provider-fallback-acceptance.md](<../../docs/operations/model-provider-fallback-acceptance.md>) | 历史记录 | 更新 |
| [docs/operations/observability.md](<../../docs/operations/observability.md>) | 现行指南与参考 | 更新 |
| [docs/operations/runtime-budgets.md](<../../docs/operations/runtime-budgets.md>) | 现行指南与参考 | 更新 |
| [docs/operations/safe-recovery.md](<../../docs/operations/safe-recovery.md>) | 现行指南与参考 | 更新 |
| [docs/operations/tracing.md](<../../docs/operations/tracing.md>) | 现行指南与参考 | 更新 |
| [docs/operations/vulnerability-response.md](<../../docs/operations/vulnerability-response.md>) | 现行指南与参考 | 更新 |
| [docs/operations/web-deploy.md](<../../docs/operations/web-deploy.md>) | 现行指南与参考 | 保留 |
| [docs/operations/web-runtime.md](<../../docs/operations/web-runtime.md>) | 现行指南与参考 | 更新 |
| [docs/production-smoke.md](<../../docs/production-smoke.md>) | 现行指南与参考 | 更新 |
| [docs/research/2026-11-06-agent-session-titles.md](<../../docs/research/2026-11-06-agent-session-titles.md>) | 历史记录 | 更新 |
| [docs/research/2026-11-08-coding-workspace-epic.md](<../../docs/research/2026-11-08-coding-workspace-epic.md>) | 历史记录 | 保留 |
| [docs/research/2026-11-08-coding-workspace-layout.md](<../../docs/research/2026-11-08-coding-workspace-layout.md>) | 历史记录 | 更新 |
| [docs/review-checklist.md](<../../docs/review-checklist.md>) | 现行指南与参考 | 更新 |
| [docs/reviews/1225-default-profile-entry/README.md](<../../docs/reviews/1225-default-profile-entry/README.md>) | 历史记录 | 保留 |
| [docs/reviews/self-hosting-ui-1591.md](<../../docs/reviews/self-hosting-ui-1591.md>) | 历史记录 | 保留 |
| [docs/run-publication.md](<../../docs/run-publication.md>) | 实施与运行参考 | 更新 |
| [docs/screenshots/2026-11-04-provider-fallback/README.md](<../../docs/screenshots/2026-11-04-provider-fallback/README.md>) | 历史记录 | 更新 |
| [docs/security/task-secret-delivery.md](<../../docs/security/task-secret-delivery.md>) | 实施与运行参考 | 保留 |
| [docs/security/task-secret-source-audit.md](<../../docs/security/task-secret-source-audit.md>) | 历史记录 | 保留 |
| [docs/self-hosting-acceptance.md](<../../docs/self-hosting-acceptance.md>) | 实施与运行参考 | 保留 |
| [docs/self-hosting-byok.md](<../../docs/self-hosting-byok.md>) | 现行指南与参考 | 保留 |
| [docs/self-hosting-github-cloud.md](<../../docs/self-hosting-github-cloud.md>) | 实施与运行参考 | 保留 |
| [docs/self-hosting-realtime.md](<../../docs/self-hosting-realtime.md>) | 现行指南与参考 | 保留 |
| [docs/self-hosting.md](<../../docs/self-hosting.md>) | 现行指南与参考 | 更新 |
| [docs/settings-backend/account.md](<../../docs/settings-backend/account.md>) | 实施与运行参考 | 更新 |
| [docs/settings-backend/activity.md](<../../docs/settings-backend/activity.md>) | 实施与运行参考 | 更新 |
| [docs/settings-backend/frontend-gaps.md](<../../docs/settings-backend/frontend-gaps.md>) | 实施与运行参考 | 保留 |
| [docs/settings-backend/prefs.md](<../../docs/settings-backend/prefs.md>) | 实施与运行参考 | 保留 |
| [docs/settings-backend/workspace.md](<../../docs/settings-backend/workspace.md>) | 实施与运行参考 | 更新 |
| [docs/settings.md](<../../docs/settings.md>) | 实施与运行参考 | 更新 |
| [docs/slack-bot.md](<../../docs/slack-bot.md>) | 实施与运行参考 | 保留 |
| [docs/suggestions-cron.md](<../../docs/suggestions-cron.md>) | 现行指南与参考 | 更新 |
| [docs/telegram.md](<../../docs/telegram.md>) | 实施与运行参考 | 更新 |
| [docs/test-accounts.md](<../../docs/test-accounts.md>) | 现行指南与参考 | 更新 |
| [docs/testing/mobile-self-hosting.md](<../../docs/testing/mobile-self-hosting.md>) | 现行指南与参考 | 保留 |
| [docs/ui-overlay.md](<../../docs/ui-overlay.md>) | 实施与运行参考 | 更新 |
| [lib/abuse/data/README.md](<../../lib/abuse/data/README.md>) | 归属与许可 | 保留 |
| [lib/self-improvement/skills/run-report/SKILL.md](<../../lib/self-improvement/skills/run-report/SKILL.md>) | 模板与指令 | 保留 |
| [packages/daemon/README.md](<../../packages/daemon/README.md>) | 现行指南与参考 | 更新 |
| [packages/daemon/THIRD_PARTY_NOTICES.md](<../../packages/daemon/THIRD_PARTY_NOTICES.md>) | 归属与许可 | 更新 |
| [packages/subscription-worker/NOTICE.md](<../../packages/subscription-worker/NOTICE.md>) | 归属与许可 | 保留 |
| [packages/subscription-worker/README.md](<../../packages/subscription-worker/README.md>) | 现行指南与参考 | 更新 |
| [scripts/acceptance/run-observability.md](<../../scripts/acceptance/run-observability.md>) | 现行指南与参考 | 更新 |
| [scripts/community-settings-ui/README.md](<../../scripts/community-settings-ui/README.md>) | 现行指南与参考 | 保留 |
| [scripts/ops/posthog/dashboard-note.md](<../../scripts/ops/posthog/dashboard-note.md>) | 历史记录 | 保留 |
| [scripts/self-hosting-ui/README.md](<../../scripts/self-hosting-ui/README.md>) | 现行指南与参考 | 保留 |
| [tasks/lessons.md](<../../tasks/lessons.md>) | 历史记录 | 更新 |
| [tests/mvp/trace-chain.md](<../../tests/mvp/trace-chain.md>) | 现行指南与参考 | 保留 |
