# Project map (项目地图)

- **Status:** accepted (2026-11-04)
- **Decision:** [`decisions/2026-11-04-1726-project-map.md`](decisions/2026-11-04-1726-project-map.md), rule R-83
- **Drafts:** review page <https://claude.ai/artifact/1ScR4ErRzDuJVo9DvEFodQ>
  (desktop light and dark, phone, a selected abandoned branch, empty state, nested forks);
  Figma file `QaYpK1uYUw1i4NjFb4WMoO`, page 「项目地图 · 2026-11-04」
- **Source:** community feedback from kumaxs: when doing research or a project
  with an AI agent, the route taken, past decisions, switched and abandoned
  branches cannot be seen at a glance; each branch's output cannot be managed;
  results and decisions are scattered across chats and files.

## What the user does

Opens a project and sees the route it took: what was done in which order,
where it forked, what was chosen and why, which branches were dropped and
where they stopped. Picks any step to see what it produced and whether it
passed review, verify and the Owner. Nobody draws or maintains the map: it is
derived from what Mikka already records.

## Where it lives

The project page gets a fourth tab, 「地图」, after 概览 and before 活动 and
任务 (`components/workspace/project-detail.tsx`). The tab replaces the page's
properties column while it is selected: the map takes the main area and the
node detail takes the right side. On a phone (below `lg`) the detail is a
bottom sheet over the map.

## Where the data comes from

The map is computed on every read from existing records. It adds no table and
no model call.

| On the map | Source |
| --- | --- |
| Nodes (steps) | The project's issues: `workspace_projects.issueIds`, only those the viewer can open (`requireIssueAccessWithoutBody`, the same check as the task page). Deleted issues are left out. |
| Order and forks | Issue relations in issue metadata (`lib/issue-metadata.ts`): an issue's **predecessor** is, in this order, the issue it is a duplicate of (`duplicateOfId`), its parent (`parentId`), or the newest issue it is blocked by (`blockedByIds`), each only when that issue is on the map. An issue with no predecessor follows the previous one in creation order, so a project without relations is one straight line. An issue with two or more successors is a fork. |
| Abandoned | Issue status `canceled` or `duplicate`. A branch is abandoned when every node on it is. |
| Main line | From the first issue, at each fork follow the successor whose subtree holds the most recently updated issue that is not abandoned. Everything else is a branch. |
| Decision at a fork | Written from the titles, not by a model: 「选了 A，放弃 B」 when the other successors are abandoned, 「同时做：A + B」 when they continue. The reason after it is the abandoned branch's stop reason (below), with its source. |
| One-line result on a card | For the viewer's own latest thread on the issue: its run summary (`runSummaryText`). For a stopped branch: where it stopped and why. Otherwise nothing. |
| Where a branch stopped, and why | The issue's newest Factory task (`factoryHumanStore.listForIssue`): its stage and status give the step (执行, Review, Verify, Owner); the reason is the newest Owner rejection note (approval ledger), else the task reason, else the thread's judged outcome reason. Each reason names its source: 「Owner 备注」 or 「AI 总结」. |
| Threads | `listIssueThreads` per issue: the thread list the task page shows, with the same redaction (a teammate's thread shows status only, R-62). 「原始对话」 opens that thread. |
| Artifacts | The viewer's own Artifacts made for the issue or by one of their runs on it (`artifacts.issueId`, `artifacts.runId`), with the latest version. |
| PRs | The issue's `metadata.pullRequests` (state, title, +/− lines). |
| Checks | The newest Factory task's review and verify attempts (`factoryHumanStore.read`), and the approval ledger: Owner approved, requested changes, merged. |

A teammate who can open an issue but not its threads or Factory task (they
are owner-scoped) sees the node, its PRs and the route, never another
person's thread content, Factory evidence or Artifacts.

## Layout and states

- **Map.** A vertical timeline, oldest at the top. Date gutter on the left;
  the main line is lane 0. Each node is a wide card (two lines: status, title,
  number and the chips Artifact / PR / Review / Verify on the first; the
  one-line result on the second). The current step is a hollow yellow dot.
- **Fork.** A diamond on the lane it forks from, with one line: the decision,
  「·」, the reason, and 「原始对话」 when there is a thread to open.
- **Branches.** A branch opens one lane (32px) to the right of the lane it
  forks from. The option that continues stays in the parent's lane. Branch
  subtrees are drawn right after their fork, so each branch reads as one
  block, then the parent continues. A finished branch frees its lane. An
  abandoned branch is dashed and muted, and ends in the abandoned mark.
- **Depth.** Desktop draws lanes 0–2, a phone lanes 0–1. A branch that would
  need a deeper lane folds into one row 「<branch> · N 步」; opening it shows
  only that branch, with a breadcrumb 主线 › … › <branch> to go back.
- **Fold.** Any branch folds to one row (chevron), showing its step count and
  where it stopped. The toolbar's fold button folds or unfolds all branches.
- **Filters.** 全部 / 主线 / 已放弃 / 有 Artifact. 主线 folds every branch.
  已放弃 and 有 Artifact keep the structure and fade the nodes that do not
  match. Search fades every node whose title, decision, reason, Artifact or
  PR title does not contain the text.
- **Zoom.** − / percentage / + (60–140% in steps of 20), 「适应窗口」 fits the
  map's height, 「定位当前」 scrolls to the current step. A minimap in the
  bottom-right corner of the desktop map shows the whole route and the visible
  part; clicking it scrolls there.
- **Selection.** Clicking a node selects it, highlights its path from the
  first node in the accent colour and opens the detail. Esc closes the
  detail. The selection is view state (`useViewState`), not an address.
- **Detail (desktop, right side, resizable R-80; phone, bottom sheet).**
  Header: status, number, close; title; status pill, Agent, dates. Then, in
  order: 任务 (the description's opening, at most 280 characters, and
  「打开任务」), 决定 (the fork this node came from: decision, reason with its
  source, 「查看原始对话」, the abandoned or chosen alternative), for an
  abandoned node 停在 (执行 → Review → Verify → Owner, with the step it
  stopped at in red), Artifact (title, version, date), PR (state, title,
  +/−), 检查 (Review, Verify, Owner), 对话摘要 (the latest own thread's run
  summary and 「查看原始对话」), 线程 (the thread rows, as R-53).
- **Empty.** A project with one issue shows that node and one line plus one
  button (R-41): 「还只有起点」 · 「交给 Bot 拆分」, which opens the issue so the
  person can hand it to a bot. A project with no issues shows 「还没有任务」
  and 「新建任务」. Filters, zoom and fold are disabled while there is one node
  or none.
- **Loading.** The tab shows the existing `Spinner` row while the map loads.
- **Error.** One line 「地图读取失败」 and 「重新读取」.
- **Dark mode.** The tokens in `app/globals.css`; no white hairlines (R-31).
- **Narrow window.** Below `lg`, the phone layout.

## Rules that apply

R-10 (no composer on the map; threads open in their own conversation), R-15
(object chips), R-30, R-31, R-32, R-33, R-34, R-36, R-37 (panels open
instantly), R-40, R-41, R-43 (Artifact, 线程, Agent), R-52/R-53 (thread rows),
R-62 (thread visibility), R-74 (Agent marks), R-80 (the detail's left edge is
resizable), R-82 (opening a task or thread goes through `navigate`).

New: **R-83** (see `rules.md`).

## Components

- New `components/workspace/project-map.tsx` (the tab: toolbar, map, minimap,
  detail) and `lib/project-map/` (`build.ts`: the pure graph and lane layout;
  `server.ts`: the reads). Nothing existing draws a branching timeline.
- Reused: `Tabs`, `Button`, `ButtonGroup`, `SearchInput`, `ToggleGroup`,
  `ResizablePane`, `Sheet`, `Spinner`, `StatusDot`-style status marks from the
  board, `AgentMark`.
- Server actions `getProjectMap(projectId)` and
  `getProjectMapNode(projectId, issueId)` in `app/actions/project-map.ts`.

## Copy

Chinese first; every string lives in `messages/zh-CN.json` and
`messages/en.json` under `Projects.map`.

| Key | 中文 | English |
| --- | --- | --- |
| tab | 地图 | Map |
| filterAll / filterMain / filterAbandoned / filterArtifacts | 全部 / 主线 / 已放弃 / 有 Artifact | All / Main line / Abandoned / With Artifact |
| search | 搜索节点、决定、Artifact | Search steps, decisions, Artifacts |
| foldAll / unfoldAll | 折叠分支 / 展开分支 | Fold branches / Unfold branches |
| zoomIn / zoomOut / fit / locate | 放大 / 缩小 / 适应窗口 / 定位当前 | Zoom in / Zoom out / Fit / Go to current |
| minimap | 小地图 | Minimap |
| chose | 选了 {chosen}，放弃 {dropped} | Chose {chosen}, dropped {dropped} |
| parallel | 同时做：{items} | In parallel: {items} |
| source.owner / source.ai | Owner 备注 / AI 总结 | Owner note / AI summary |
| openConversation | 原始对话 / 查看原始对话 | Conversation / View conversation |
| steps | {count} 步 | {count} steps |
| stoppedAt | 停在 {step} | Stopped at {step} |
| step.execute / review / verify / owner | 执行 / Review / Verify / Owner | Execute / Review / Verify / Owner |
| section.task / decision / stopped / artifacts / pullRequests / checks / summary / threads | 任务 / 决定 / 停在 / Artifact / PR / 检查 / 对话摘要 / 线程 | Task / Decision / Stopped at / Artifact / PR / Checks / Summary / Threads |
| openTask | 打开任务 | Open task |
| main | 主线 | Main line |
| onlyStart / splitWithBot | 还只有起点 / 交给 Bot 拆分 | Only the starting point / Hand to a bot |
| noIssues | 还没有任务 | No tasks yet |
| loadFailed / reload | 地图读取失败 / 重新读取 | Map failed to load / Reload |
| check.passed / failed / pending / approved / changesRequested / merged | 通过 / 未过 / 进行中 / 通过 / 驳回 / 已合并 | Passed / Failed / In progress / Approved / Changes requested / Merged |
| close | 关闭 | Close |

## Out of scope

- No new table, stored map, or model call; no AI-written decision text beyond
  the judged reasons that already exist.
- No editing on the map: relations, statuses and decisions are changed on the
  task, as today.
- No merge lines: an issue with two predecessors hangs off the newest one.
- No horizontal layout and no time-scaled axis.
- Projects with more than 100 issues are already capped by `issueIds`.

## Done when

- `docs/review-checklist.md` passes, with screenshots of a local production
  build (desktop light and dark, phone, abandoned branch selected, empty)
  attached to the PR.
- Unit tests cover the graph: straight line, fork with an abandoned branch,
  parallel fork, nested forks, lane reuse, depth folding, main-line choice,
  predecessor precedence, filters and search.
- A database test covers `getProjectMap`: an issue the viewer cannot open is
  not on the map; another member's thread content and Factory data never
  appear; deleted issues are left out.
- `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check` pass.
