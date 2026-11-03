# Chat quote and copy, against Figma C1–C6

Accepted frames: Figma `zPe5LKycb2XuT1ivCLRw07`, page `902:2` (decision `docs/design/decisions/2026-11-03-0455-chat-quote-and-copy.md`).

Local run on cloud Linux: `pnpm dev:local` (next dev, Node 24.22.1), isolated PostgreSQL 16 database `mikka_shots3_e2e`,
real DeepSeek flash model (workspace key from Infisical `dev:/vercel`), no daemon, automatic test-account lease
(`scripts/test-accounts/session.mjs`). C1–C5 were shot at revision `13dfcc7e16ea1bd7114f0d66b60576a0cb2e901e`, using
Playwright with `zh-CN` at 1280×860, light and dark (`colorScheme`).

| Frame | Light | Dark | What it shows |
| --- | --- | --- | --- |
| C1 `903:2` | `C1-reply-copy-light.png`, `C1-person-copy-light.png` | `…-dark.png` | 复制 under a hovered reply and under the person's message |
| C2 `910:2` | `C2-selection-popover-light.png` | `…-dark.png` | Words selected in a reply: 引用 / 复制, the Artifact reader's popover (`SelectionActions`) |
| C3 `905:2` | `C3-composer-chip-light.png` | `…-dark.png` | The quote above the draft, removable |
| C4 `906:2` | `C4-sent-quote-light.png` | `C4-sent-quote-dark.png` (top bubble) | The quote at the top of the blue bubble, in the bubble's own text colour |
| C5 `907:2` | `C5-copied-light.png` | `…-dark.png` | Tick and 「已复制」 beside it; the clipboard held the reply's Markdown |
| C6 `908:2` | `C6-*.png` (earlier run at `58d8980`, unchanged code) | — | Thinking as it is: 「已思考」 collapsed and opened, 「正在处理…」 while waiting |

`code-block-copy.png`: a code block's own 复制, which copied the code as written.

In the dark pass the Coordinator was still busy, so the second quoted message was not sent. The dark C4 shot shows the
quoted message sent during the light pass, at the top of the chat.

Not covered here: the live 「思考中」 line. In these dev:local runs the page only showed 「正在处理…」 and then the stored
reply, with no live stream drawn. The thread chat's quote and copy are covered by `scripts/thread-composer.test.tsx`;
no daemon was run, so there is no live thread.
