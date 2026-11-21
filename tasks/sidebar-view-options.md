# 侧栏视图能力（对齐 Capy 0.9.2 的分区菜单）

## 现状（已确认）

- 侧栏列表由 **私有 `mikka-hosted-ui`** 画：`slots/app-frame.tsx`（`ShellGroup` + `SectionHeading`）与
  `components/mikka/capy-sidebar.tsx`（行和标题）。公开仓库只提供数据：`components/nav/bot-list.tsx`
  的 `useChatNav`（`ChatNavEntry[]`）经 `RailProps.chats` 交给外框。
- 「显示密度 详细/紧凑」已经能用：`app-frame.tsx` 的 `useViewState('sidebar-density')` → `CaptainRowContent`。
- 已读机制已有：`POST /api/conversations/read-state` 的 `readAll`（`lib/thread-reads.ts`）会把这个工作区的
  所有 run 和本人创建的群聊标为已读；Bot 自己的聊天在 `conversation_reads` 的 `bot:<id>` 键上，靠
  `POST /api/conversations/bot:<id>/read {messageId}` 推进，`readAll` 不动它。
- 没有文件夹：`chat_preferences` 只有 `pinned / muted / hidden / markedUnread / pinOrder / listOrder`，
  `setChatPreference` 也只收这几个字段，没有任何读侧返回文件夹。

## 计划

- [x] `components/nav/sidebar-view.ts`：视图模型（密度 / 排序 / 分组 / 筛选 / 查询）纯函数 + 分区可用维度
- [x] `lib/hooks/use-sidebar-view.ts`：用 `useViewState` 持久化（沿用 `sidebar-density` 键）
- [x] `components/nav/sidebar-view.test.ts`：纯函数单测（10 条）
- [x] `lib/hooks/use-sidebar-view.test.tsx`：状态与持久化单测（6 条）
- [x] `components/nav/bot-list.tsx`：`useChatNav` 增加 `markAllRead`（readAll + 逐个 Bot/群聊已读）
- [x] `components/nav/rail-items.ts` + `components/workspace/issue-workspace.tsx`：`RailProps.chats.onMarkAllRead`
- [x] `messages/*.json`：新文案（zh-CN / en 同步，23 个键）
- [x] `.hosted-ui/components/mikka/capy-sidebar.tsx`：`SectionHeading` 菜单数据化、`SubHeading`、`SidebarSearchField`
- [x] `.hosted-ui/slots/app-frame.tsx`：两个分区的菜单接线，排序 / 分组 / 筛选 / 搜索真的作用到行
- [x] 验证：lint-ui 0 errors、i18n 通过、单测 16 条、`tsrs` exit 0、hosted `tsc` 无新增错误

## 验证记录（2026-11-20）

| 命令 | 结果 |
| --- | --- |
| `node scripts/lint-ui.mjs` | `0 errors`（4175 business files） |
| `node scripts/check-i18n.mjs` | passed |
| `node --import tsx --test components/nav/sidebar-view.test.ts` | 10/10 |
| `node --import tsx --test lib/hooks/use-sidebar-view.test.tsx` | 6/6 |
| `scripts/server-test + tsx --test tests/idle-request-budget.test.tsx` | 13/13 |
| `... --test lib/hooks/view-state.test.tsx components/nav/thread-view-state.test.tsx components/nav/use-save-bot.test.ts components/nav/chat-row-actions.test.ts` | 22/22 |
| `... --test components/workspace/issue-workspace-settings.test.tsx components/workspace/group-chat-revalidation.test.tsx` | 43/43 |
| `./node_modules/.bin/tsrs --noEmit -p tsconfig.json` | exit 0 |
| `.hosted-ui`: `tsc --noEmit` | 与干净 HEAD 完全相同的 3 条既有错误（`review-page.tsx` ×2、`slots/chat-message.tsx` ×1），本次改动 0 新增 |

## 不做

- 新建文件夹：`chat_preferences` 只有 `pinned / muted / hidden / markedUnread / pinOrder / listOrder`（`lib/db/schema.ts:1034`），
  `ChatPreference`/`ChatChange`（`lib/chat-preferences.ts:8,10`）与两个 PATCH 路由也只认这些字段，
  侧栏读侧（`listConversationSidebar`、`ChatNavEntry`）没有任何分组键。要做得先加列 + 迁移 + 读写接口，不在本次范围。
- 未在运行中的产品里点一遍（本机没有起 dev server，hosted 侧栏需要整套 stack + 登录 + 真实 Bot）。

