# Components: what to use, what not to bring back

Pick the component from the "Use" table. If nothing fits, use reUI, then
shadcn (`components/ui/`), then write a new one and add it here in the same
PR. `pnpm lint:ui` blocks hand-built UI that a library component covers.

## Use

| Job | Use | Notes |
| --- | --- | --- |
| App shell (window, top bar, rail, content card) | `components/app-shell.tsx`, `components/nav/icon-rail.tsx` | Comma structure, R-35 |
| Bot list (left) | `components/nav/bot-list.tsx` | Coordinator and bots, R-01 |
| Centre chat title | `components/nav/conversation-pill.tsx` | Borderless, centred |
| Right panel | `components/nav/context-panel.tsx` | No input box in the thread list or under a screen; an open thread ends in the composer, R-10 |
| Composer | `ChatComposer` in `components/coordinator/chat-composer.tsx` (`InputGroup` + `InputGroupTextarea`) | Attachment button, no model picker. Reuse it for every chat |
| Personal account approvals above the composer | `PendingActions` and `ApprovedWriteActions` in `components/coordinator/` | Existing card layout; ledger-backed Notion, Slack and Calendar deletion use `/api/approved-writes`, never the legacy decider. Unknown results have no effectful retry button; a verified pending result can explicitly restore approval controls without sending a decision |
| Messages | `components/ui/message.tsx`, `components/ui/bubble.tsx`, `MessageScroller*` | R-13, R-14 |
| Task, run and source chips in chat | OpenUI `TaskChip`, `RunChip`, `SourceChip` (`components/workspace/agent-ui-library.tsx`, data from `agent-citations.tsx`) | R-15 |
| Cards, tables and charts the Coordinator writes (OpenUI Lang) | `lib/agent-ui-catalog.ts` (ours) plus OpenUI's own built-ins, themed by `components/workspace/agent-theme.tsx` | Per job: card `BeCard`, figures `BeStat`, table `BeTable`, tabs `BeTabs`, collapsible `BeCollapsible`, alert `BeAlert`, code `BeCodeBlock`, image `BeImage`, charts `BarChart` / `LineChart` / `AreaChart` / `DonutChart` (ours; `BarChart` horizontal for rankings), used-versus-limit `RadialChart`, buttons `BeButton` / `BeFollowUps`; status OpenUI `Tag`, milestones OpenUI `Steps`, a batch to review OpenUI `Form` + `EditableTable` (our renderer). Verdicts: 2026-10-31 in `decisions.md`. OpenUI's own components are not restyled with app CSS; only `createTheme` keys |
| Thread card under a Coordinator reply | `components/coordinator/thread-card.tsx`; opens `IssueThreadPanel` in the centre | R-66 |
| GitHub PR state icons | `components/workspace/pull-request-icon.tsx` | Shared open/draft/merged/closed icons and Primer semantic colors; used in task properties, board and thread outputs |
| Thread state icon | `components/workspace/thread-status-icon.tsx` | Shared by thread card, thread list and open-thread header; Bot avatars remain for actual Bot actors only (R-62/R-66) |
| New task | `components/coordinator/new-task-dialog.tsx` | R-22, R-23 |
| Search | reUI `CommandDialog` (⌘K), centred | Local rows first, then `GET /api/search` hits per source (`hooks/use-site-search.ts`) |
| Group chat (opened from search) | `components/workspace/group-chat-view.tsx` | Read-only until group sending opens: no composer (R-10). Runs per R-13; bot colour not available yet |
| Board | reUI `Kanban` (`components/reui/kanban.tsx`) | R-25 |
| Status | StatusBadge set; `components/nav/status-dot.tsx` for devices | R-24, R-34 |
| People avatars | `components/nav/letter-avatar.tsx`, `components/user-avatar.tsx` | |
| Bot avatars | `BotAvatar` (`components/nav/bot-avatar.tsx`, bloub, Figma `196:3571`) | R-36 |
| Buttons, badges, dialogs, menus, tabs, switches | reUI first, then `components/ui/*` | Figma style guide rule 4 |
| Segmented control (scope, view switch) | `ToggleGroup variant="segment" size="sm" spacing={0.5}` (`components/ui/toggle-group.tsx`) | One `--control` track at the button height (28px at `sm`), 8px radius, pressed item raised; no per-call height, radius or grey overrides (R-31, R-33; ui-policy `style/segment-track`) |
| Filter chip (board toolbar) | One `--control` container: field, value, ghost `icon-xs` remove (`board-page.tsx`) | Same 28px height and 8px radius as the `sm` buttons beside it; never a `ButtonGroup` of separate blocks |
| Brand mark | inline SVG per `brand.md` | |
| App-wide browser (top bar 🌐, Figma `412:8066`) | `components/browser/`: `BrowserToggle` (icon only, in the window bar, `lg` and up), `BrowserPane` (replaces the right panel while open), `BrowserNotesProvider` / `BrowserNoteChip` / `BrowserNoteLine` | The person's own browser, not a bot's 电脑. Every page is framed with the same sandbox, never `allow-top-navigation*`. One 选择元素 button: on a page of the app's own origin it picks an element (reusing the artifact frame's picking script); on any other origin it becomes a dragged box, so a note there carries the URL and the box, nothing read from the page. A chip reads 「1 · 周会 · 删除 · 备注」 (the item the element sits in, its name, the note; no role words), and no page text is sent. Notes are chips in the chat composer on screen and ride at the head of the next message (`lib/browser/note.ts`) |
| 建议 page (rail) | `components/suggestions/suggestion-feed.tsx`; cards from `components/suggestions/mobile-card.tsx` (`SuggestionCardBody`, `SourceMark`) | Figma F8 `420:5831`, R-21. A tapped card heads the person's message in the Coordinator chat (`lib/suggestions/card.ts`) |
| Artifact page (rail) | `components/artifacts/artifact-library.tsx`, opening `ArtifactWindow` (the reader beside the thread or Coordinator chat) | Figma F2 `395:27790`, F4 `395:27525`. Rail icon `components/icons/artifact-icon.tsx`, never lucide Copy/Library |
| Plugin (connected app) list, detail page and brand icons | `components/plugins/connected-apps.tsx`, `components/plugins/app-icons.tsx` | Codex Settings › 插件 precedent (R-70, R-71): brand tile, switch, ⋯ menu per account |
| Settings v4 sections (`551:6857`) | `components/settings/`: `workspace-settings.tsx` (常规 + 转让工作区 + 删除工作区), `access-tokens-settings.tsx` (个人访问令牌; built but hidden by `unbuilt` in `lib/settings-sections.ts` until an API accepts tokens), `secrets-settings.tsx` (密钥与环境, plus the BYO E2B key row; no frame draws it, so it follows the secret rows), `audit-log-settings.tsx` (审计日志), `team-permissions-settings.tsx` (团队权限: the existing `computer-policy-settings.tsx` row plus 允许使用的应用), `usage-settings.tsx` (用量), `billing-settings.tsx` (计费) | Built from `SettingsSection` / `SettingRow`; members get plain values, no controls (S-P); a failed save restores the value and offers 重试 (S-O, `SettingsSaveError`) |
| 计费 免费额度 / 余额 / 账单记录, and Mikka 默认 refusals (#523–#527, #558, #559) | `components/billing/`: `FreeAllowanceSection` (BIL-1/3c/5), `BalanceSection` (余额, 充值, 账单记录), `HostedRefusalNotice` (ALW-1/1b/2/3, above the composer); `components/auth/turnstile.tsx` (sign-up and 重新发送验证邮件) | Server calls go through `lib/billing/verification-client.ts` only. Card entry and payment are Stripe Checkout pages, never a form of ours. Mikka 默认 carries `MikkaMarkSmall`, the subscription button the Claude and OpenAI marks (R-74) |
| Agent outputs (documents, web pages) | `components/artifacts/`: `ArtifactCard` (in chat), `ArtifactChip` (chat beside the reader), `ArtifactViewer` (reader), `ArtifactQuoteChip` / `ArtifactQuoteLine` | Figma `178:11626`. Quoted text is marked by `remarkMarks`, never by touching the DOM |

## Do not use

Files and patterns that brought retired designs back. Do not import them into
new UI; check remaining source and test references before a cleanup removes them.

| Component | Why not | What brought it back |
| --- | --- | --- |
| `components/agents/prompt-input.tsx` (`models`, `onModelChange`) | Has a model picker (R-11) | Model picker reappeared in a bot chat |
| `components/workspace/agent-starters.tsx` | Starter cards (R-12) | "试试从这些事情开始" in a bot chat |
| `components/workspace/agent-demo*.tsx` | Demo content | |
| `components/app-sidebar.tsx`, `nav-main.tsx`, `nav-secondary.tsx` | shadcn sidebar shell, replaced by the Comma shell; no callers left, safe to delete | Shell that "looked like a wireframe" |
| reUI Pro App Shell blocks (`app-shell-*`) | Extensible shells that do not fit Mikka (Alex 2026-10-23) | |
| HeroUI gradient-sphere avatars for bots | Replaced by bloub (R-36) | |
| OpenUI Lang `Shadcn*` / `Reui*` components (including `ShadcnProgress`), `BeBadge`, `BeTimeline` | Duplicates of an OpenUI built-in or a beUI component (2026-10-31); old saved replies stay readable in the chat archive only | Overlapping copies of table, tabs, alert, badge and card in the catalog |
| An input in the thread list or under a computer screen | Not a conversation (R-10) | 「指挥这个任务…」 field |
| shadcn `Input` defaults in dark mode | `border-input` draws a white hairline (R-31) | |

## Historical chat compatibility

`legacy-chat-archive.tsx` displays saved pre-retirement chat records read-only.
It has no composer, generation request or retry execution. Historical replies
use an accessible static projection: every saved Accordion item and Tab is
expanded as readable text; live ComputerCard and action components are never
mounted. The body is selectable and remains in the accessibility tree. The standalone `agent-panel`, `agent-chat`, `agent-composer`, `agent-welcome`
and `agent-response` generation host components are retired. Shared `agent-*`
rendering primitives used by the current Bot are retained; their internal names
are not a separate product entity.

## Changing this list

Adding a component, retiring one, or moving one between the tables is a
change to this file in the same PR. If you delete a "Do not use" component,
remove its row.
