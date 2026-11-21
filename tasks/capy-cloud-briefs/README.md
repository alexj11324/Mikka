# Capy 对齐 · 云端会话交接说明

2026-11-20：本地机器负载过高，S1–S7 从本地会话移到云端。每个本地会话没提交的进度都打成了一个 WIP 提交，推在 `wip/s1-issue-states` … `wip/s7-agent-interop`。

所有工作包共同的规则：
- 先 `git fetch origin <你的 wip 分支> docs/capy-alignment-decisions`，从 wip 分支接着做，**不要重写**已有的部分。最后整理成干净的提交，基于最新 `origin/main`（`git rebase origin/main`）推到 `feat/...` 分支。
- 必读：本分支的 `tasks/capy-alignment-plan.md`（获批总计划）、`tasks/capy-alignment-backend-gaps.md`、`docs/design/decisions/2026-11-19-21*.md`，以及仓库的 `AGENTS.md`（thread/线程术语、不新增轮询、错误带 cause、中英文案 `messages/*.json`、功能默认开启、迁移用 UTC 时间戳）。
- 付费 UI（affectUI / BoardUI Pro / beUI Pro）的源码只能放私有仓库 `alexj11324/mikka-hosted-ui`。如果能用 `gh repo clone` 拿到它，就开分支实现并开 PR。拿不到时，先完成后端和公开仓库的默认版，并在 PR 描述里列出 hosted-ui 需要改的清单。
- 云端没有 Capy 安装包和 Figma，以计划文件和缺口文档为准。
- 七个云端会话并行，`lib/db/schema.ts`、`messages/*.json` 会冲突。开 PR 前再 rebase 一次 `origin/main`。
- 完成标准：单元测试 + 数据库测试，typecheck / lint 通过；推送并开 PR（英文，不带 attribution），PR 描述写清验证了什么、哪些没覆盖，例如本地生产构建截图、两条订阅路径的实时验收、生产验收。结束时汇报 PR 链接、迁移名、未完成项。
