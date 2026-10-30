# Mikka MCP server

Agents such as Claude Code and Codex can drive Mikka through its MCP server at
`https://app.aspectlylabs.com/mikka/api/mcp` (Streamable HTTP).

How to connect and the tool list for users are in the public docs:
[aspectlylabs.com/mikka/docs/mcp](https://aspectlylabs.com/mikka/docs/mcp)
(`mikka-web/content/docs/mcp.mdx`). This page covers the implementation.

## Tools

`get_issue` also returns the issue's project, labels, assignee and relations.
Writes run the app's own server actions inside `actAs` (`lib/acting-user.ts`),
so an agent gets the same validation and access checks as the UI; a refused
write returns the action's error code (`issueNotFound`, `issueParentCycle`…).

## Dispatch transactions

The shared `queueRun` path accepts an optional `requestKey` (1–200 characters).
The owner/key binds the issue, agent, repository and normalized note. A
transactional advisory lock serializes each key, and another serializes new
dispatches by owner/issue. A matching replay returns the original `runId`, its
current `status` and `replayed: true`, including terminal runs. Changed
parameters return `runDispatchKeyConflict`; an overlapping new run returns
`runAlreadyActive`. Access checks run before replay lookup. Unkeyed legacy
callers use the same overlap gate but cannot replay after a run ends.

## How sign-in works

The app is an OAuth 2.1 server (better-auth's `@better-auth/oauth-provider`
plugin, configured in `lib/auth.ts`, tables in `drizzle/0009_oauth_provider.sql`).

- The MCP route answers 401 with a `WWW-Authenticate` header pointing at the
  protected resource metadata (`/mikka/.well-known/oauth-protected-resource`).
- The authorization server metadata is at
  `/mikka/.well-known/oauth-authorization-server`; the root paths RFC 8414 and
  RFC 9728 expect redirect there (`next.config.mjs`).
- Clients register themselves (dynamic client registration) and use PKCE.
- Sign-in goes through `/sign-in`, which sends the person back to the
  authorize request (`oauthResumePath` in `lib/auth-return.ts`), then the
  consent page at `/oauth/consent`.
- Access tokens (`mka_…`, one hour) and refresh tokens (`mkr_…`) are opaque and
  stored hashed. `lib/mcp/auth.ts` checks them against the database.

## Worker tools (inside a run)

The agent inside a run talks to the same URL with a run token (`mkw_…`)
instead of OAuth. The claim response (`POST /v1/devices/:deviceId/runs/:runId/claim`)
hands the daemon `mcp: { url, token }`; the daemon mounts the server into the
run with `Authorization: Bearer <token>`. The token's prefix makes the route
serve these tools instead of the ones above (`lib/mcp/worker.ts`):

| Tool | Coordinator event | Payload |
| --- | --- | --- |
| `report` | `run_report` | `{ text }`, a milestone note; use sparingly |
| `ask` | `run_question` | `{ question, options?, context? }`; returns at once, the answer arrives as a follow-up instruction |
| `blocked` | `run_blocked` | `{ reason }` |
| `submit_artifact` | `artifact_submitted` | `{ title, kind: 'markdown' \| 'html', content, artifactId? }`; one event per version |

Each call writes one event with the run's `userId`, `runId` and `issueId` and
wakes the Coordinator. Tokens are stored hashed (`run_tokens`,
`drizzle/0012_run_tokens.sql`), live at most 24 hours, work only while the run
is live, and are revoked when the run completes.

## Artifacts

`submit_artifact` is the one way every harness hands over a document or a web
page. It works with both token kinds; inside a run the artifact is tied to the
run and its issue, and the author shown is the agent's name.

- Limits: title 200 characters, Markdown 1 MB, HTML 2 MB (`lib/artifacts/limits.ts`).
  HTML must be one file: scripts and styles inline, images as `data:` URLs.
- Files go to Cloudflare R2 (bucket `mikka-artifacts`, keys
  `<userId>/<artifactId>/v<n>-<sha>.<ext>`); versions and share tokens live in
  Neon (`artifacts`, `artifact_versions`, `artifact_shares`). Without R2 keys
  (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), development
  and previews keep the file in the row; production refuses.
- Markdown is rendered in the app with react-markdown (raw HTML stays text).
  HTML is served from `/api/artifacts/<id>/versions/<n>/frame` under a CSP
  `sandbox allow-scripts allow-popups` with `connect-src 'none'`, and shown in
  an iframe without `allow-same-origin`, so it runs in an opaque origin with no
  cookies and no network. The injected script
  (`packages/protocol/src/artifact-frame.ts`) handles 选择元素 and talks to the
  app only through `postMessage`.
- Each version records `artifact_submitted` for the Coordinator, which shows
  the artifact as a card under its next reply. A quote the person sends from
  the reader reaches the Coordinator as
  `<quote artifact=".." version="2" kind="text|element">…</quote>` before the message.

## Run captures (screenshots and recordings)

A thread keeps screenshots and screen recordings as evidence of its work
(`lib/captures`). They are not artifacts: binary, immutable, unversioned, and
they post no card and wake no Coordinator. Each belongs to one run, its
issue and its Bot, and only the run's owner reads it (R-62).

- Types and limits (`packages/protocol/src/capture.ts`): PNG, JPEG, WebP up to
  10 MB; MP4, WebM up to 100 MB. The type is read from the file's bytes,
  never its name or a declared type.
- Files go to the artifacts R2 bucket under
  `<userId>/runs/<runId>/captures/<id>.<ext>`; rows live in `run_captures`,
  unverified uploads use `capture-uploads/` until copied to a separate verified
  key. A bucket lifecycle rule for that prefix is needed to expire staging
  objects recreated with a still-valid signed URL. Share links live in
  `run_capture_shares` (hashed `mkc_…` tokens, revocable, as
  artifact shares). Without R2 keys the file stays in the row (previews,
  tests; uploads there are capped at 4 MB); production refuses.
- Reads: `GET /api/runs/:runId/evidence` lists a run's captures and the
  documents it handed over; `GET /api/captures/:id` serves one (byte ranges
  for video); `GET /api/captures/shared/:token` serves a shared one. Media is
  served with `nosniff` and a `sandbox` CSP.
- Factory evidence (A3): a Factory stage's screenshots and recordings are
  these captures, referenced as `run-capture:<id>` evidence (no second copy).
  The trusted reconcilers add the run's ready captures next to its report;
  the reviewer's manifest lists them with `captureId`. Approval binds the
  candidate commit, as Factory.ai, Warp, Devin and Codex do: the evidence
  digest covers the text artifacts only, exactly as before. The window serves
  captures through `GET /api/factory/tasks/:taskId/evidence/:captureId`: the
  acceptance authorization (task owner, issue access and scope) plus the
  owner-scoped capture read. A recording still running when the run ends is
  not in that stage's evidence.

Two ways in, both through the daemon, since a run's agent has no server
credential (cloud threads also have no network):

| Where the thread runs | Tools | Path |
| --- | --- | --- |
| Local daemon (Playwright on the person's machine) | `submit_capture { path, title }` on the daemon's `mikka` MCP | The MCP copies a file from the worktree or the run's temp dir into the run dir; the daemon checks it again (no links, bytes, limit), then `POST /v1/runs/:runId/captures` → PUT to a presigned R2 URL (or the server without a bucket) → `POST …/:captureId/complete`, where the server re-reads the object and checks size, sha256 and type before it counts |
| Cloud computer | `capture_screenshot { title }`, `start_screen_recording { title, maxSeconds? }`, `stop_screen_recording {}` on `mikka_computer` | The cloud worker relays the call to `POST /v1/runs/:runId/screen`; the server picks the desktop from the run's binding and runs `scripts/e2b/screen-capture.sh` (ffmpeg x11grab) in the sandbox through E2B |

Cloud captures need no per-call review: the image never goes back to the
model. New screenshots and recordings are refused while the person holds the
desktop; a recording already in progress continues and can still be stopped.
Captures are refused when the workspace turned computers off. A recording is one per thread, 120 seconds
by default and at most 300; ffmpeg's `-t` and `timeout` end it on the machine
even if nobody calls stop, and the run's end (completion or lease loss) stops
and keeps whatever is still recording. A later capture operation removes
uncollected files older than an hour; there is no independent cleanup timer.
Screenshot and recording starts serialize with revocation and STOP, with a
bounded wait and cancellation. If an issued provider request times out or
is cancelled, its outcome is unknown; it is not automatically retried and
the caller must not assume the remote operation was undone.

The daemon can resume an upload it registered while the run was active, even
after that run ends, while its 15-minute reservation is valid. A stop request
or revoked device credential still denies access. It cannot create a new
reservation after the run ends; an unregistered or expired file remains in
the local queue for inspection instead of being silently discarded.
