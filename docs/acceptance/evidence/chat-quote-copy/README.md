# Chat quote, copy and AI Elements coverage

Local run on cloud Linux, `pnpm dev:local` (next dev, Node 24.22.1), isolated PostgreSQL 16 database
`mikka_shots2_e2e`, real DeepSeek flash model (workspace key from Infisical `dev:/vercel`), no daemon,
automatic test-account lease (`scripts/test-accounts/session.mjs`). Revision under test:
`58d898037787f347c77287c18ead3c7f428fd807` (CSS-only quote-line fix after `134e49e`). Playwright, `zh-CN`, 1280×860.

| Shot | What it shows |
| --- | --- |
| `01a-working-before-reply.png` | While the reply is on its way: 「Coordinator 正在处理…」 (the live stream never reached the page in this run, see below) |
| `02-reply-done-thinking-collapsed.png` | Stored reply: 「已思考」, actions under the newest reply |
| `03-thinking-open.png` | 「已思考」 opened: the model's own reasoning, loaded on open |
| `04-copy-hover.png`, `05-copy-copied.png` | 复制 under the reply; after a click the icon is a tick. The clipboard held the Markdown (`**…**`, list markers, the fenced block) |
| `06-selection-quote-popover.png` | Words selected in a reply, 引用 above them |
| `07-composer-quote-chip.png` | The quote above the draft, with ✕ |
| `08-sent-with-quote.png`, `09-quoted-answer.png` | The sent message: quote line above the words; the Coordinator answers about that part |
| `10-copy-person-message.png` | 复制 under the person's own message |
| `11-code-block-copy.png` | A code block's own 复制 (copied the code as written) |

Not covered here: the live 「思考中」 line. In this dev:local run the page only showed 「正在处理…」 and then the stored reply,
so no live stream (and no live thinking) was drawn; the code path is covered by `tests/coordinator-streaming-render.test.tsx`.
The thread chat's quote and copy are covered by `scripts/thread-composer.test.tsx` (no daemon was run for a live thread).
