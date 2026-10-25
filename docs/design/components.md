# Components: what to use, what not to bring back

Pick the component from the "Use" table. If nothing fits, use reUI, then
shadcn (`components/ui/`), then write a new one and add it here in the same
PR. `pnpm lint:ui` blocks hand-built UI that a library component covers.

## Use

| Job | Use | Notes |
| --- | --- | --- |
| App shell (window, top bar, rail, content card) | `components/app-shell.tsx`, `components/nav/icon-rail.tsx` | Comma structure, R-35 |
| Bot list (left) | `components/nav/conversation-list.tsx` | Lists bots; the file name is old, the model is the glossary's |
| Centre chat title | `components/nav/conversation-pill.tsx` | Borderless, centred |
| Right panel | `components/nav/context-panel.tsx` | No input box in the thread list or under a screen; an open thread ends in the composer, R-10 |
| Composer | the composer in `components/coordinator/coordinator-chat.tsx` (`InputGroup` + `InputGroupTextarea`) | Attachment button, no model picker. Reuse it for every chat |
| Messages | `components/ui/message.tsx`, `components/ui/bubble.tsx`, `MessageScroller*` | R-13, R-14 |
| Task, run and source chips in chat | OpenUI `TaskChip`, `RunChip`, `SourceChip` (`components/workspace/agent-ui-library.tsx`, data from `agent-citations.tsx`) | R-15 |
| Thread card under a Coordinator reply | `components/coordinator/thread-card.tsx`; opens `IssueThreadPanel` in the centre | R-66 |
| New task | `components/coordinator/new-task-dialog.tsx` | R-22, R-23 |
| Search | reUI `CommandDialog` (⌘K), centred | |
| Board | reUI `Kanban` (`components/reui/kanban.tsx`) | R-25 |
| Status | StatusBadge set; `components/nav/status-dot.tsx` for devices | R-24, R-34 |
| People avatars | `components/nav/letter-avatar.tsx`, `components/user-avatar.tsx` | |
| Bot avatars | `BotAvatar` (bloub, Figma `196:3571`) | R-36. Not on main yet: it lands with the bot list PR |
| Buttons, badges, dialogs, menus, tabs, switches | reUI first, then `components/ui/*` | Figma style guide rule 4 |
| Brand mark | inline SVG per `brand.md` | |

## Do not use

These still exist in the repo, mostly for the old agent page. Copying from
them is how retired designs came back. Do not import them into new UI; delete
them when their last caller goes.

| Component | Why not | What brought it back |
| --- | --- | --- |
| `components/agents/prompt-input.tsx` (`models`, `onModelChange`) | Has a model picker (R-11) | Model picker reappeared in a bot chat |
| `components/workspace/agent-welcome.tsx`, `agent-starters.tsx` | Starter cards (R-12) | "试试从这些事情开始" in a bot chat |
| `components/workspace/agent-composer.tsx` | Starters in the `+` menu; second composer (R-10, R-12) | |
| `components/workspace/agent-demo*.tsx` | Demo content | |
| `components/app-sidebar.tsx`, `nav-main.tsx`, `nav-secondary.tsx` | shadcn sidebar shell, replaced by the Comma shell; no callers left, safe to delete | Shell that "looked like a wireframe" |
| reUI Pro App Shell blocks (`app-shell-*`) | Extensible shells that do not fit Mikka (Alex 2026-10-23) | |
| HeroUI gradient-sphere avatars for bots | Replaced by bloub (R-36) | |
| An input in the thread list or under a computer screen | Not a conversation (R-10) | 「指挥这个任务…」 field |
| shadcn `Input` defaults in dark mode | `border-input` draws a white hairline (R-31) | |

## Changing this list

Adding a component, retiring one, or moving one between the tables is a
change to this file in the same PR. If you delete a "Do not use" component,
remove its row.
