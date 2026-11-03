# Chat attachment repair — local acceptance

Source: branch `work`, based on `c23ff74f921b7951c5d7016c0e0967e3ce6e3e1f`,
with the attachment changes in the working tree. The final runtime source hash
is recorded in `.cache/attachments/api-evidence.json`; the API harness checks
that the source is unchanged during each run. No PR, CI run, merge or production
deployment was created by this task.

Design: [accepted A1–A10](https://www.figma.com/design/zPe5LKycb2XuT1ivCLRw07?node-id=917-456).
Alex approved after the long-filename correction: 「现在可以了，继续吧」.

## User tasks and regression evidence

| Task | Before | Implemented and checked |
| --- | --- | --- |
| Drop or paste a file in a Bot, group or Agent thread | Shared composer had no file drop/paste handlers | Shared handlers, native text paste preserved, disabled/sending entry points guarded; composer DOM fixtures cover all three scopes |
| Send Markdown, code or structured text | Only the old text-file picker path existed | Original bytes, original Markdown/code syntax and immutable references; text, CSV and JSON production HTTP round trips |
| Send common binary documents and images | No general file transport | DOCX, XLSX, PDF, RTF and PNG processed through the production build and verified against extracted content and original downloads; XLS/PPTX/ODF/EPUB parser fixtures also pass |
| Send a file without accompanying words | No file-only contract | Bot/group/thread references are nonempty messages; real group and live Agent API sends accepted |
| Edit while uploading, recover from failure | No upload lifecycle | Draft edits survive asynchronous completion; pending/errors block send; retry/remove are exposed; uncertain completion reuses the same upload |
| Read yesterday's sent file | No binary history | Private authenticated download and native open/share; removing a reused draft cannot delete a sent file |
| Keep a long filename within the card | Figma filename wrapped outside its fixed card | One-line ellipsis with the full name retained; ready/sent cards reviewed in both themes and at 390px and 1440px |
| Deliver files to a live Agent | No materialization path | Authenticated device download bound to the assigned run, live token and actual file reference; real daemon startup and interjection both receive safe original/extracted paths |
| Revoke file access | No file-specific scope contract | Foreign owner/chat denied, drafts private, current group/workspace membership enforced, revoked device token refused; PostgreSQL tests |

Bug triage: missing drag/paste handlers reproduce on every file attempt
(occurrence 10 × impact 5 = 50). Long names reproducibly crossed the fixed-height
Figma card (10 × 3 = 30). Upload response loss could otherwise duplicate a file
or audio processing (4 × 5 = 20); an uncertain retry retains its identity.
Remote object reads now enforce the declared byte budget while streaming so an
oversized signed upload cannot be buffered before validation (3 × 7 = 21).

## Environment and results

- Cloud Linux, Node 24.19.0; PostgreSQL 17.11 in an owned temporary data directory,
  loopback port 55433. App/workspace/account-pool targets use the same isolated
  database. No production database writes.
- Optimized `next build` and `next start`, application origin
  `http://localhost:3100/mikka`; automatic account allocation uses normal signup,
  signin and session APIs, with environment and build attestation.
- `test:chat-attachments-api`: original bytes, immutable completion/send retry,
  private access, production document/image parsing, group and Agent input.
  The generated report lists every completed check.
- `test:chat-actions`: 17 format/protocol/retry checks and 17 DOM/action checks.
- Attachment/account/export/cleanup/device-fence PostgreSQL selection: 19 passed.
  The attachment-only suite was rerun after the bounded-storage change: 5 passed.
- Real daemon and run lifecycle selection: 47 passed. The Agent adapter is the
  recorded mock harness; this proves daemon delivery and actual local bytes,
  rather than an external Claude/Codex inference.
- Root, mobile and daemon typechecks; code/UI lint; migration inventory and
  migration gates pass. The `pnpm check` suites were run in stages: after fixing
  the new DB inventory registration and empty-attachment rendering, the affected
  suites and remaining suites passed. Logs are retained under `/tmp/mikka-attachments-*`.
- `LOCAL_LOOP_ITEMS=4 pnpm test:local-loop`: passed on a separately owned local
  database at `http://localhost:3110`, using the real configured DeepSeek model
  for Agent/group communication. The generated fixed-source and environment
  reports remain under `.cache/dev-local/acceptance-aa179eccc5b045e3/`.
- Production screenshot review only; no browser interaction tests. Four captures,
  light/dark × 390/1440px, and geometry readback found no overflowing filename
  rows or horizontal page overflow. The screenshots and layout report remain
  under `.cache/attachments/screenshots/`.

## Practical limits

- Up to 10 files per message, 25 MiB per file, 200,000 extracted characters in
  total. Over-budget content is rejected rather than silently truncated.
- Audio transcription requires an authorized OpenAI key whose reported catalogue
  includes a transcription model. No live OpenAI transcription was invoked in
  acceptance. Missing-key and failed processing remain explicit upload errors.
- Textless PDF model input requires a PDF-capable selected model. Embedded Office
  graphics and animated GIF frames are not fully reproduced in text extraction;
  original files remain available, and Bot image input uses a static resized frame.
- Native source and tests pass, but this Linux environment did not run iOS/Android
  device acceptance. Clipboard images use the native system paste control;
  arbitrary native documents use the system picker.
- Local acceptance uses the existing inline storage adapter. The configured cloud
  identity did not provide R2 object credentials, so live R2 PUT/read/delete and
  bucket CORS were not exercised. Production reuses the artifacts bucket; browser
  signed PUT requires that bucket to allow the application origin and Content-Type.
- Production deployment and Git-linked CI remain outside this local change.
