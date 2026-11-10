# Files in every chat

- **Status:** accepted by Alex after the long-filename correction; implementation
  source paths are listed below. Earlier acceptance belongs to its recorded
  revision and environment; [acceptance](../acceptance.md) defines the evidence
  required for a later change.
- **Figma:** [all-chat attachments, page `917:456`](https://www.figma.com/design/zPe5LKycb2XuT1ivCLRw07?node-id=917-456).
  A1–A10 are accepted frames.
- **Source:** [Alex's requested scope](decisions/2026-11-03-1242-all-chat-attachments.md).

## What the user does

Drop, paste or select files, review the attachments, and send them to a bot,
a group or the Agent working in a thread. The recipient reads the actual
contents. A person can remove an attachment, retry a failed upload, and open
or download a file they sent.

## Coverage

| Surface | Current entry and transport | Implemented path |
| --- | --- | --- |
| Bot chat, web and desktop | `components/coordinator/coordinator-chat.tsx`; shared `ChatComposer`; `useCoordinatorSubmit` | Attachments in immutable submission identity, send, retry, history and reload; connect existing server image support |
| Group chat, web and desktop | `components/workspace/group-chat-view.tsx`; shared `ChatComposer`; group message transport | Store and authorize attachments with the group's message; all answering bots receive content |
| Agent thread, web and desktop | `components/workspace/issue-thread-panel.tsx`; shared `ChatComposer`; `sendIssueThreadReply` | Carry file references through live input and ended-thread continuation; materialize files for the actual harness, including image input |
| Mobile bot chat | `apps/mobile/lib/attachments.ts`; image outbox and text-file picker | Match supported formats, preserve native camera/library/file pickers and failed-message retry |
| Mobile Agent thread | Native thread composer and thread message transport | Same files and delivery behavior as web threads; native selection and clipboard where available |
| Mobile group chat | Native group composer and message transport | Same private file contract, upload lifecycle and history downloads |
| New-task entry | `components/coordinator/new-task-dialog.tsx`; text-file picker | Preserve attachments when handing the request to its selected bot |

The unused `components/agents/prompt-input.tsx` is a library component, not an
additional live chat entry point. Read-only archives stay read-only.

## Format baseline

Official sources checked on 2026-11-03:

- [ChatGPT: uploading files and audio](https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt).
- [Claude: upload files](https://support.claude.com/en/articles/8241126-upload-files-to-claude).

| Files | Treatment |
| --- | --- |
| Markdown (`.md`, `.markdown`, `.mdx`), text, source code, JSON, YAML, TOML, XML, HTML, logs | Preserve original bytes and filename; supply original text, including Markdown syntax |
| CSV, TSV, XLS, XLSX | Preserve sheets, headers and cell values; provide structured tabular content |
| PDF | Extract embedded text; textless PDFs reach the selected model as original PDF input, requiring PDF-capable model support |
| DOCX, PPTX, ODT, ODS, ODP, RTF, EPUB | Extract ordered document/slide content; retain the original for inspection and download |
| PNG, JPEG, WebP, GIF | Preview and provide actual image input; state any animation handling explicitly |
| WAV, MP3/MPEG, OGG/OGA, FLAC, AAC, M4A, PCM, audio-only WebM/MP4 | Validate audio and transcribe with an authorized OpenAI key; reject video payloads and show a key-required error if no key is available |

Do not advertise a format until its complete delivery path has a fixture and
passes. Model-specific context and media limits are checked explicitly; file
contents must never be silently truncated. Upload limits are not copied from
competitors without checking Mikka's storage and model constraints.

## Layout and states

Reuse the accepted C3 composer shape and the existing
`components/ui/attachment.tsx` primitives. Attachments occupy the area above
the draft, next to any quote. Keep the existing model picker, send and stop
behavior. Filename and file type/size identify each file; avoid explanatory
subtitles. Click opens a preview; each unsent file has a labeled remove action.
Ready attachments alone can be sent. Pending or failed uploads cannot be
silently omitted from the message.

Filename and metadata each occupy one line with ellipsis within the card's
available width. Keep the full original filename in the attachment identity,
accessible label and preview; hovering or focusing the name reveals it.
The remove/retry control never shrinks to make space for a name. Multiple
cards wrap between cards, rather than wrapping a filename inside a fixed-height
card. Native/touch remove and retry targets are at least 44px.

Each accepted frame has light and dark versions:

| Frame | Node | State |
| --- | --- | --- |
| A0 | `917:457` | Copy of the accepted C3 composer for comparison |
| A1 | `918:16` | Bot/group: Markdown, spreadsheet and PDF ready |
| A2 | `918:171` | Agent thread: screenshot, code and Word document ready |
| A3 | `918:320` | Uploading and parsing |
| A4 | `918:441` | Failed/offline: draft retained, retry and remove |
| A5 | `918:570` | Sent files: preview and download |
| A6 | `918:691` | File drag target |
| A7 | `918:754` | Long filename and multiple files |
| A8 | `918:959` | Audio attachment |
| A9 | `918:1052` | 390px mobile/narrow window, wrapped files |
| A10 | `918:1173` | Attachment-only message |

Keyboard users reach file selection, preview, retry and remove. Native text
pasting and text dragging keep their normal behavior. File drops cannot
navigate the application away. A disabled composer rejects all attachment
entry points consistently.

## Delivery requirements

Use a shared, authenticated attachment contract, with immutable file identity,
name, type, size and readiness state. Keep original files in private storage;
reuse existing storage infrastructure rather than putting binary content in
the text draft. Validate type, bytes and processing budgets on the server.

Resolve access from the actual chat/thread membership and recipient scope.
Daemon downloads must be bound to the authorized run and materialized to a
safe local path. A pasted URL or filename is not an uploaded file. Cleanup
must cover removed drafts, deleted chats and account deletion.

The send idempotency key includes attachment identities. An uncertain send
reuses the same files and request identity. An accepted message retains file
history; a failure retains the original draft and files. Switching bot, group
or thread never sends the previous surface's attachments to the new one.

## Review and validation

- Applicable rules: R-10 (shared composer), R-31 (surfaces), R-40 (copy),
  R-42 (translations), R-74 (icons).
- Design uses the existing horizontal attachment component and Lucide file,
  image and audio icons. Text uses the shared renderer's Inter font from
  `apps/desktop/src/renderer/styles.css`; no shell-layout change.
- The interface-design and unslop checks were applied: inherited neutral
  surfaces, compact file rows, one send action, no decorative badges or filler.
  A visual pass corrected icon/remove contrast in both themes.
- Alex identified A7's filename wrapping outside its fixed-height card.
  Every accepted card now limits both text rows to one ellipsized line;
  the read-back audit checks text bounds in all attachment states, including
  390px layouts. Full filenames are preserved.
- Source review confirms the shared web composer reaches bots, groups and
  Agent threads. The native phone transport needs its own changes; checking
  the web component alone does not establish mobile parity.
- Required acceptance: every listed format with real fixture content, all
  three entry methods, multiple files, attachment-only sends, failed reads,
  pending/failed upload handling, resend/reload, surface switches, private
  access, and live/ended Agent-thread delivery. Use local API/CLI acceptance
  and screenshots of a local production build in cloud Linux, following
  [acceptance](../acceptance.md).

The current text-only bug repair is covered by
`components/coordinator/chat-composer.test.tsx`, included in
`pnpm test:chat-actions` and therefore `pnpm check`.

## Implementation limits

Each message accepts up to 10 files, 25 MiB per file and 200,000 extracted
characters across its files. Processing rejects over-budget documents instead
of silently truncating them. Images are retained unchanged for download and
Agent access; Bot model input is a static image resized to at most 2048px.
Animated GIF model input uses its first frame. Audio uses the existing usable
OpenAI API-key permissions and a transcription model in its reported catalogue; no Mikka-funded key is
selected implicitly. Historical files retain private authenticated downloads.

File references are immutable and scope-bound. Agent hosts fetch only files
actually referenced by the assigned run and write original bytes and extracted
text under UUID-based local filenames before starting or interjecting.

## Production transport

Browser and native uploads use authenticated same-origin parts of at most
3 MiB. The server stages parts in the private attachment row, checks ordered
offsets and exact repeated bytes, then validates the full file and writes its
immutable original to the existing private R2 store. Each part is below
Vercel's request-body limit; uploads do not depend on R2 browser CORS or public
object access. Failed/abandoned partial rows follow the draft cleanup lifecycle.

URL prefix ownership is enforced by
[the base-path decision](decisions/2026-11-03-1430-base-path-single-owner.md).

Original R2 downloads use an authenticated app route followed by a private
60-second storage URL, so 25 MiB originals do not traverse the function's
response-body limit. The device API returns that capability with the verified
file metadata; the daemon reads it without forwarding its device credential,
bounds the bytes and verifies their hash before exposing a local path. Native
sharing likewise sends its session only to Mikka. No bucket CORS or public
access change is required.

Platform limit: [Vercel Functions payload limits](https://vercel.com/docs/functions/limitations#request-body-size).
