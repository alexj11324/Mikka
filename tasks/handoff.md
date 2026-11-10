# Mikka 交接单 — Capy 对齐批次（2026-11-10 21:15 UTC）

接手者请先读完「硬约束」和「已定决策」，再动任何分支。所有数字以本文末尾的「快照时间」为准；PR head 和 CI 会继续变化，动手前用 `gh pr view` / `gh pr checks` 复核。

---

## 0. 一句话状态

`main` 仍是 `08a08bec0`。批次 1（PR #1887）已把 #1879 的 Git history 修复并入，正在跑 CI；批次 3 的冲突预演已完成，最大风险是 #1886 的 16 个语义冲突和 3 条迁移编号。**没有任何东西被合并到 main**。

---

## 1. 硬约束（违反会返工）

- 本机**禁止**运行：Next.js 的 `dev` / `start` / `build`、`pnpm build`、`pnpm typecheck`、`pnpm install`、本地 Postgres / server、本地打包。只能跑 source-only 单测（`node --test`、`node --import tsx --test`）和 node 脚本。
- 禁止 force push、禁止 rebase 已推送历史、禁止 squash 合并；批次用 `git merge --no-ff`，PR 合入 main 用普通 merge。
- 不提交 secrets。凭据从本机环境变量或已授权 CLI 取，不回显。
- 改完用户可见 UI 必须自己验证，不能说「请你试一下」。
- 搜索用 Exa（当前 MCP 连不上），库文档优先 context7。
- 对话与文档用简体中文；commit message 用英文。

---

## 2. 在途 PR 台账（快照 21:15 UTC）

| PR | head | 状态 | 下一步 |
|---|---|---|---|
| **#1887** 批次 1（`batch/capy-parity-2`） | `bc5211000` | 26 pass / 8 pending / **1 fail** | 红在 `Integration unit checks`（job 130125615335），但**不是代码失败**：`scripts/team-import-contract.test.mjs:14` 的子进程 15s 超时被杀（`killed:true, signal:SIGTERM, stdout:''`，duration 15103ms），该文件在批次里没被改过，main 上同 job 是 success → 超时 flake。已触发定向重跑。DB 1–4 仍 pending |
| **#1888** 常驻复制/来源 + 等待句 | `79925cb56` | 13 pass / 9 pending / **0 fail** | 三项红已修（DB 预算重新冻结 + Button 替换）。等终态；之后进批次 3 |
| **#1886** Thread modes Plan/Execute/Ask | `a8f5b82f9` | CI 重跑中 | 迁移已改名 `20261110220000`、Core 断言已加强为 `capture('github-allowed')`。**评审 REQUEST CHANGES：2 个 MEDIUM 未修**（见 §4.1） |
| **#1891** composer 模式选择器 | `113189d07` | 9 pending | **stacked 在 #1886 上**，必须 #1886 先合；禁止 retarget 到 main 直接合 |
| **#1880** workspace 权限面 | `2c0cfacbc` | 20 pass / 8 pending / **1 fail** | **P0 未修完**：Gmail/Calendar 一等写路径绕过 workspace 档位（详见 §4）。`permissions-fix` 已接手。红在 `Database checks (3/4)` |
| **#1877** Agent Profiles | `c7df1c9b3` | 35 pass / 2 pending | 迁移必须改名到 `20261110240000_agent_profile_skill_shares.sql`（批次 1 落 main 后会过不了水位） || **#1754** Review UI public half | `73a617986` | **21 pass / 0 fail** | 全绿，可合；用户可见 half 在私有仓 `mikka-hosted-ui#39` |
| **#1875** Environments | `c9f24416f` | 29 pass / 6 pending | 等终态；打包验收三态结论待补 |
| **#1695** Project v2 | `ae9d63884` | 3 pass / 14 pending | 8 项红已定位并大部分修复；**9 个迁移已改名为 `20261111010000`–`010008`，9 处代码/测试引用 + 2 篇文档同步更新**（`scripts/migrate.mjs:100,105`、`run-db-tests.mjs:21,25`、`migration-steps.test.mjs:25`、`project-v2.db.test.ts:54`、`domain-lifecycle.db.test.ts:35`、`task-identity.db.test.ts:94-96`、`computer/store.db.test.ts:66`、`domain-model-rollout.md`、team-lifecycle ADR）。前置：与 #1889 同批或其后，#1889 不得重复 apply；DB4 `test:live-db` 需一次干净运行 |
| **#1884** 权限文档 | `fae5a8419` | 1 pass | 5 处 P0 + `ui-overlay.md` 的 app-policy 行已补回；等复核后进批次 3 |
| #1878 Run origin | `7479136a2` | 32 pass / 0 fail | 批次 3 可选 |
| #1883 Slack 切片 | `12e992115` | 0 冲突 | 批次 3 |
| #1890 workspace 文档 | `4d4155b1e` | 0 冲突 | 批次 3 |
| #1889 迁移底座 | — | open，base main | **必须先于 #1695 合入 main** |

---

## 3. 批次 3 顺序（已预演，基线 `bc5211000`）

```
#1877 → #1883 → #1888 → #1878(可选) → #1884 → #1890 → #1886 → #1891，尾随 #1754
```

预演结论：

- **#1886 有 16 个语义冲突**，已逐文件判定：**唯一互斥项是 `components/settings/bot-permissions.tsx`**（批次侧 workspace-only vs #1886 仍写 per-Bot 收窄），以批次侧为准、采纳 #1886 的 Collapsible 与懒加载 UI，标 `#1886 must adapt`；其余 15 个都是并集，但 `run-admission-store.ts` / `computer/queue-run.ts` / `run-leases.ts` / `run-quota.ts` 的顺序敏感（`expectedMode`、`freezeThreadMode`、`resolveRunOrigin` 的插入位置有先后要求）。清单见 `.../reports/batch3-1886-conflict-map.md`。
- `routes.{json,ts}` **不要手写并集**，合并后必须重跑 `node apps/api/scripts/generate-routes.mjs`，否则 governance 的 fixed-source 必红。
- `steps.ts` 命名冲突：批次侧是三态 `githubCallAllowedStep`，#1886 是布尔 `githubCallAllowed`；保留三态，`tools.ts` 调用同步改三态。
- **#1884 有 7 个 docs 冲突**，逐文件并集方案见 `.../reports/batch3-1884-docs-resolution.md`。
- #1878 唯一冲突是 `lib/coordinator/group-turns.test.ts` 的内联 DDL，取 ours 超集。
- #1891 只有 `docs/design/components.md` 一处冲突。
- 生成物 `apps/api/generated/routes.{json,ts}` 不要手写并集，合并后重跑生成器。

---

## 4. 未修的 P0（接手第一优先）

**#1880：Gmail/Calendar 一等写路径绕过 workspace 档位。**
- `workflows/coordinator/steps.ts:490-495` 的 `accountWrite` 只查 `appBlockedForBot`（读 `workspace_app_policies`，Coordinator 直接放行）；`lib/pending-action-store.ts:24-37` 的 `writeAccountAction` 只调 judge。
- `lib/operations/app-permission-keys.ts:8` 的 `LEGACY_WRITE_ACTIONS` 不含 `send_email` / `create_calendar_event` / `update_calendar_event`。
- 后果：页面把 Gmail 设为「不允许」，`call_app_tool(GMAIL_*)` 被拦，但 Coordinator 的 `send_email` 照发。
- 改法：`APPROVAL_ACTIONS` 映射到 app，deny→拒、ask→出卡、allow→跳过 judge，补三条测试。
- 同批 P1：`app-tools-server.ts:34-39` 的「判不出来就拒绝」、`pending-actions.ts:41-47,65-79` 批准时不重读 workspace、`bot-permissions.tsx:65-66,72,184` 的 `bots?.[0]` 锚点。

---

## 4.1 #1886 评审阻断（2 个 MEDIUM，合入前必修）

1. **provider fallback 会静默回滚用户选的线程模式。**
   `lib/thread-mode/store.ts:45-65` 的 `freezeThreadMode` 把任何显式 `requested` 都当成 thread transition，更新 `task_thread_modes`、bump version、写 `thread.mode_changed` 审计。而 `lib/run-provider-fallback.ts:256-267` 与 `lib/agent-runs.ts:223-227` 在 fallback 时传 `mode: source.mode`；源 run 是 `failed`（terminal，`run-provider-fallback.ts:217`），`unfinishedRun` 不拦。用户在这段窗口把 ask 改成 execute 后，fallback 又把它改回 ask。
   改法：拆分「冻结 run 的 mode」与「切换 thread 的 mode」——continuation 只把源 mode 写进新 run 行，不碰 `task_thread_modes`/version/audit。先例：`lib/run-quota.ts:163-167`、`lib/factory/questions/queue-continuation.ts:87-88`。

2. **mode API 用 task 创建者做授权，与 workspace-only / per-person 设计矛盾。**
   `lib/thread-mode/store.ts:81` 的 `SELECT "workspaceId" FROM issues WHERE id=$1 AND "userId"=$2 FOR SHARE` 额外要求 caller 是 issue 的 `userId`。但 `threadModeTarget` 只校验 run owner、`requireTaskWorkspace` 只校验 workspace 成员；team workspace 里成员在队友 task 上拥有 run 时，GET 正常、POST 却 409。测试 `lib/thread-mode/store.db.test.ts:89-95` 把这个错误行为固化了。
   改法：保留 `FOR SHARE`，去掉 `AND "userId"=$2`（或在事务内校验 run 的 owner/issue 可见性），测试改成「run owner 可切自己的行；非 workspace 成员由 route 拒绝」。

LOW（可后续 PR）：`approvals.ts:129-132` 过期状态在事务内 throw 导致 ROLLBACK、`approvals.ts:176-182` 的 list 缺 membership fence、`mode/route.ts:50-56` 成员校验在事务外、Codex 把所有 MCP 都送进 gate 与 server 侧判定重复、`lib/run-app-mcp.ts:18,26` 的 `runMode` 缺省 execute 应改 fail closed、Claude Ask 放行 `mcp__mikka_computer__`（UNVERIFIED，需确认 broker 在 `allow` 下是否逐步 ask）。

---

## 5. 迁移水位与编号分配

批次 1 落 main 后，main 最新迁移 = `20261110210000_coding_workspace_git.sql`。任何 PR 的新迁移必须 **> 它**。

| 分配 | 值 | 备注 |
|---|---|---|
| #1886 | `20261110220000_thread_modes.sql` | 待核是否已改名 |
| #1877 | `20261110240000_agent_profile_skill_shares.sql` | 待执行 |
| #1880 | `20261110250000` / `20261110250001` | 原 230000/230001 撞号 |
| 已占用 | `20261110230000` / `20261110230001` | #1789、#1892、api-m4 争用，勿用 |

**#1695 / #1889 去重（已收敛）**：两边 9 个迁移逐字节相同。#1695 已把文件名从 `20261110151000`–`151008` 改为 **`20261111010000`–`010008`**（与 #1889 同名同内容），并同步了 9 处代码/测试引用与 2 篇文档。现在的状态是：**两条分支同名同内容，谁先合都行，后到的一方按 `schema_migrations(name)` 判定已应用而跳过**。要求：#1889 与 #1695 同批或 #1889 先合；合并后关闭 #1889。禁止 rebase。若部署账本已记录旧名 `20261110151000`–`08`，必须核对 `schema_migrations` 后再上。

完整水位表：`.../reports/migration-watermark.md`。

---

## 6. 已定决策（不要重新讨论）

1. **workspace 是唯一授权面**；per-Bot / per-worker 层已退役；no-workspace run 读 owner 的 legacy Coordinator head 作为 explicit ceiling，且绝不放大成 allow。
2. **文档以 `lib/operations/write-judgment.ts` 为准**，不拿过期注释当依据。`readOnlyHint` 只是 evidence；判不出来 → 不出卡 + 调用照常 + 记 `Write judgment fallback`。
3. **#1891 必须后于 #1886 合**，stacked 关系不拆、不 rebase。
4. `IssueThread.mode` 数据层保留（有测试、不碰 ACL、是将来 teammate 徽标的唯一非 ACL 数据源）。
5. **CI 流程**：head 冻结 → 评审 → 一次性修完 → 一次 push。评审结论在 CI 跑完前到位且修复是阻断的，直接 `gh run cancel` 重推，不要白等重 job。
6. 批次合并顺序固定为 §3；预演用「累积树」而不是「每个 PR 对基线」。

---

## 7. 未开始的 15 项与依赖

- UI：#1731 Files 查看（**已解阻**，后端 #1743 在 main）、#1733 终端/Preview（等 #1782）、#1735 IDE（等 #1886/#1891）、#1714 Project v2 UI（等 #1695）
- 编辑/多 Agent：#1728 受控源码编辑/CAS（**已解阻**）、#1729 共享工作区（等 #1728/#1730）
- 入口接线：M1 Slack thread link、M2 Linear outbox、M3 GitHub 出站回复（都等 #1878 的 origin 合同进 main）
- API/自动化：M4 PAT dispatch、M5 Automation v0（等 #1878）
- 其它：Factory 生产验收（等 #1789）、Coordinator 闭环可靠性（无 owner）、per-Bot 权限层代码删除（等 #1880）
- 范围外：Capy 规模能力（volumes/cloud phones/Explore/MCP marketplace 等）

8 份实施 brief 已落盘：`.../reports/unstarted-briefs.md`（751 行，覆盖 Files UI、Review UI、终端 UI、IDE、Project v2 UI、源码编辑/CAS、M1–M5 接线、Coordinator 闭环 + 权限清理 + Factory 验收）。每条含：判定（unblocked/partial/blocked）、现在能开工的切片、涉及文件、实施步骤、与在途 PR 的冲突面、前几个 commit、风险。

要点：#1731 Files UI **完全解阻**（后端 #1743 在 main），brief 已拆成 11 个可独立合入的切片；#1733/#1735/#1714 分别卡在 #1782/#1886+#1891/#1695；M1–M5 都等 #1878 的 origin 合同进 main。

---

## 8. 详细报告索引

`/Users/alexjiang/Desktop/vibe/Mikka-parity/.superpowers/sdd/2026-11-10-capy-parity/reports/`

- `unstarted-briefs.md` — 15 个未开始项的实施 brief（751 行，可直接照着做）
- `capy-gap-refresh.md` — 36 项能力盘点（4 已补齐 / 17 进行中 / 15 未开始）
- `batch3-conflict-rehearsal.md` — 批次 3 逐 PR 冲突与迁移
- `batch3-1884-docs-resolution.md` — 7 个 docs 冲突的并集方案
- `migration-watermark.md` — 迁移水位与撞号清单
- `factory-acceptance-checklist.md` — #1783 生产验收步骤（生成中）
- `review-*.md` — 各 PR 评审记录

---

## 9. 仍在运行的 agent（接手者可复用或停掉）

`batch-final-reviewer`（#1886 评审）、`p0-macos-reviewer`（#1880 复审，待 permissions-fix 推送）、`git-history`（批次 1 CI + 迁移水位）、`batch-gate`（#1886 冲突清单）、`thread-modes`（#1886/#1891 修复）、`agent-profiles`（#1877）、`domain-model`（#1695）、`permissions-fix`（#1880 P0）、`factory-delivery`（Factory 验收清单）、`docs-fix-perms`（#1884）、`docs-fix-main`、`p0-thread-implementer`（#1886 独立验证）、`env-setup`（#1875）、`pty-preview`（#1754）。闲着的 Explore agents 有 5 个（cloud/gstack/factory/entries/macos-recon）。

---

## 10. 零散但重要的事实

- **CI 不跑浏览器测试**：`.github/workflows/browser-gate.yml` 按 decision 2026-11-01-1520 已退化成 echo，只为保住 required check 名字。任何只靠 Playwright 的守卫永远不会让 CI 变红。
- **`generate-routes.mjs` 的 `--check` 未实现**，UI policy 声称的「生成物未同步」检查是假绿。已有一个未完成分支 `zero/a-route-check`（本地 commit `1cf716fde`，+110/−7，未 push）。
- **过期注释**：`lib/app-tools.ts:11-15`、`:66`、`lib/pending-action-store.ts:19-20`、`lib/app-tools.test.ts:56` 标题都与 `write-judgment.ts` 相反。已有本地分支 `zero/b-stale-comments`（commit `5b96763db`，未 push）。
- **未完成工作已全部推到 GitHub**（2026-11-10 21:20 UTC，均为 WIP，未开 PR、未验证）：
  - `wip/handoff-2026-11-10` — 本交接单
  - `zero/a-route-check` — `generate-routes.mjs --check` 的未完成实现（+110/−7，`1cf716fde`）
  - `zero/b-stale-comments` — 过期注释清理，已完成但未验证（`5b96763db`）
  - `wip/chat-actions-20261110` — #1888 的测试加固（citation 预算算式注释、stopReason 计数断言、等待句可点击 e2e），基于 `79925cb56`
  - `wip/thread-modes-20261110` — #1886 的 2 个 MEDIUM 修复进行到一半（`thread-mode/store.ts`、`run-provider-fallback.ts`、`run-admission-store.ts`、`queue-run.ts`、`run-quota.ts`、`run-leases.ts`、`agent-runs.ts`），基于 `a8f5b82f9`
  - `wip/bot-permissions-20261110` — #1880 的 P0 修复进行到一半（`account-write-setting.ts` 新增、`steps.ts`/`pending-action-store.ts`/`app-tools.ts` 改动、迁移已改名 250000/250001），基于 `2c0cfacbc`
- `~/.config/mikka/zero-cat.env`（chmod 600）保存了 zero.cat 的 base URL 与 key，已停用；是否删除待定。

---

## 快照时间

2026-11-10 21:15 UTC。`main` = `08a08bec0`。
