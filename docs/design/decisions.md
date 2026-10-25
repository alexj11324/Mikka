# Decision log

One row per product or design decision Alex made. Add the row the day you
hear it, quoting where it was said. If a decision replaces an older one,
mark the older row ~~struck~~ and point to the new one; never delete rows.
When a decision becomes a standing rule, add it to `rules.md` and link the
rule id here.

Newest first.

## Decided

| Date | Decision | Rule | Replaces |
| --- | --- | --- | --- |
| 2026-10-25 | Sign-in: Google button uses Google's official "G" mark; no scope or callback-URL notes under the OAuth buttons; divider reads "or" / 「或」 (「这个是假的」「删一下口水话」) | R-40 | "Or use email" divider |
| 2026-10-24 21:57 | Clef is fully replaced by the OpenAI Decisions API, including the first auto-approval screen (「10月22日那个东西已经过时了，已经完全换成了 OpenAI 的 decisions API」) | R-20 | Clef (2026-10-22) |
| 2026-10-24 21:57 | Right panel = 建议 + 任务; 任务 = threads started by the orchestrator or a bot, all kept, not the board's issues; a clicked suggestion fills the composer, the bot dispatches a thread, and the item moves from 建议 down to 任务 | R-21 | 建议 / bot threads / 我的任务 (20:46); 任务 tab = flat board list (2026-10-23) |
| 2026-10-24 21:57 | bloub keeps all 16 shapes | R-36 | |
| 2026-10-24 21:57 | Task scope is two-way: a workspace task in Linear can be turned back into a personal one (「保持双向」); code in issue #184 | R-26 | "Once in Linear it can't revert" (2026-10-23, MIK-30) |
| 2026-10-24 21:51 | No filler or explanatory copy anywhere in the UI (口水话) | R-40 | |
| 2026-10-24 21:50 | The Coordinator has no special UI; it is a normal bot (no star, no badge, no special empty state) | R-06 | Coordinator bloub with an orange star |
| 2026-10-24 21:28 | Artifact hosting: files in Cloudflare R2; versions, permissions and share tokens in Neon. HTML renders in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`) and a strict CSP; no separate user-content domain. Share links at `app.aspectlylabs.com/mikka/a/<token>` (only me / workspace / anyone with the link; revocable; noindex). Markdown renders in-app, sanitized | | |
| 2026-10-24 21:13 | Right panel 详情 header = the selected bot (same bloub and name as the left row) + 「<Bot 名> 的屏幕」; thread names only in the thread list | R-02, R-17 | An earlier relay that put the run name in the header |
| 2026-10-24 20:43 | Bot chat = plain conversation, no starter cards; Coordinator avatar is a bloub (see 21:50); 新建 Bot dialog is Grok-sized (big preview, shapes above, colours below) | R-06, R-12, R-05 | |
| ~~2026-10-24 20:46~~ | ~~Right panel with a bot selected keeps 建议, then the bot's threads, then 我的任务~~ (replaced 21:57) | R-21 | |
| 2026-10-24 19:36 | Bots run only on Mikka's AI SDK harness; own `bots` table; 新建 Bot = shape, colour, name only | R-05 | Bots as rows in `agents` |
| 2026-10-24 19:20 | Machine picker: Mikka Cloud first and default, then 本机, then Remote control; Settings › 设备 uses the same groups | R-23 | |
| 2026-10-24 19:17 | Device online state = StatusDot on the icon, never a text badge | R-24 | |
| 2026-10-24 18:56 | Left = bot list, right = thread list, no "conversation list" (`glossary.md`, PR #175) | R-01 | "会话" in the nav v3 handoff (#88) |
| 2026-10-24 | Right panel never has an input box; one centre composer; no model picker; one-to-one chats without avatars; bubble rules | R-10, R-11, R-13, R-14 | |
| 2026-10-24 00:38 | Every bot has its own computer; no 新建云端电脑 entry | R-04 | |
| 2026-10-24 | Bot avatars are bloub animated blobs | R-36 | HeroUI gradient spheres (2026-10-22) |
| 2026-10-23 23:13 | "No Coordinator" applies only to action entry points; conversation headers keep the Coordinator pill | R-07 | An over-broad removal |
| 2026-10-23 22:47 | No task creation on the board; one 新建任务 dialog, one sentence, Coordinator writes the task | R-22 | Column `+` |
| 2026-10-23 | Figma decides layout; Comma decides look; build on Comma's app shell; no reUI App Shell blocks; reUI components wherever one exists | R-35, `README.md` | |
| 2026-10-23 | Light-theme greys pure neutral | R-30, R-38 | Slate-tinted overlays |
| 2026-10-23 | Suggestions list = external webhook notifications only | R-20 | Coordinator suggestions in the list |
| 2026-10-23 | UI is reviewed as one Artifact page; no filler copy; e2e only after Alex accepts the UI | `review-checklist.md`, R-40 | Screenshot attachments |

## Accepted Figma frames

Only these frames count as a source (file `zPe5LKycb2XuT1ivCLRw07`).

| Area | Section / frames | Accepted |
| --- | --- | --- |
| Nav v3.1 shell | `48:2` (as implemented in PR #165) | 2026-10-24 |
| Kanban v2 | `77:2`, frames `89:2`–`92:2` | 2026-10-23 |
| Cloud computer | `102:65` | 2026-10-24 06:19 |
| Style guide | `98:2` (rule 8 out of date, see R-36) | 2026-10-24 |
| 新建 Bot dialog | `195:3225` | in review |
| Group chat | `205:4488` | in review |
| Artifact viewer | `178:11626` | in review |

## Open

Questions waiting on Alex. Move a row to "Decided" when he answers.

| Since | Question | Default until answered |
| --- | --- | --- |
| 2026-10-24 | Remove white hairlines app-wide (dialog and popover rings, column borders), not only inputs? | Inputs only |
| 2026-10-24 | Token drift between Figma and code (`rules.md` § Tokens): which side moves? | Code value ships, Figma follows |
