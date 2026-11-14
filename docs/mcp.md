# Mikka MCP server

Agents such as Claude Code and Codex can drive Mikka through its MCP server at
`https://app.aspectlylabs.com/mikka/api/mcp` (Streamable HTTP).

Every call names one Mikka workspace and is authorized against it:
`lib/mcp/workspace.ts` resolves the caller's workspace, checks membership and
refuses a call with no resolvable workspace (`workspaceAccessDenied`).

Target contract: each connection is scoped to one Mikka workspace, and the
workspace's MCP-server policy (allow / disable / read-only) is checked before
every call. Today an OAuth connection may name any workspace its user belongs
to, and `workspace_app_policies` covers connected apps (allow / deny), not MCP
servers.

How to connect and the tool list for users are in the public docs:
[aspectlylabs.com/mikka/docs/mcp](https://aspectlylabs.com/mikka/docs/mcp)
(maintained in the separate `mikka-web` repository). This page covers the
implementation. The deployed API is served by the
[Hono/Nitro runtime](operations/web-runtime.md), which reuses the handlers
under `app/`.

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
  RFC 9728 expect redirect there (`apps/api/runtime/http-policy.mjs`).
- Clients register themselves (dynamic client registration) and use PKCE.
- Sign-in goes through `/sign-in`, which sends the person back to the
  authorize request (`oauthResumePath` in `lib/auth-return.ts`), then the
  consent page at `/oauth/consent`.
- Access tokens (`mka_…`, one hour) and refresh tokens (`mkr_…`) are opaque and
  stored hashed. `lib/mcp/auth.ts` checks them against the database.
- Target contract: each OAuth grant is pinned to one workspace
  (`authInfo.extra.workspaceId`); a request naming another workspace returns
  `workspaceAccessDenied`. Consent grants the current workspace only, and the
  token cannot read or write another workspace. Run tokens already carry the
  run's `workspaceId` and are pinned to it; OAuth grants are not pinned yet.

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
wakes the Coordinator. The event belongs to the run's bot, whose workspace
places it in the right workspace; `coordinator_events` has no separate
workspace column. Tokens are stored hashed (`run_tokens`,
`drizzle/0012_run_tokens.sql`), live at most 24 hours, work only while the run
is live, and are revoked when the run completes.

## Artifacts

`submit_artifact` is the one way every harness hands over a document or a web
page. It works with both token kinds; inside a run the artifact is tied to the
run and its issue, and the author shown is the agent's name.

- Limits: title 200 characters, Markdown 1 MB, HTML 2 MB (`lib/artifacts/limits.ts`).
  HTML must be one file: scripts and styles inline, images as `data:` URLs.
- Files use the configured S3-compatible bucket, including Cloudflare R2
  (default R2 bucket `mikka-artifacts`, keys
  `<userId>/<artifactId>/v<n>-<sha>.<ext>`); versions and share tokens live in
  PostgreSQL (`artifacts`, `artifact_versions`, `artifact_shares`).
  `lib/artifacts/storage.ts` prefers a configured S3-compatible bucket, then
  R2. Without a bucket, community deployments and non-production cloud
  environments keep the file in the row. Cloud Vercel production refuses.
  See [self-hosted storage configuration](self-hosting-byok.md#文件与-s3-兼容存储).
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
  artifact shares). The shared S3/R2 configuration also serves captures.
  Without a bucket, community deployments and non-production cloud
  environments keep the file in the row, with uploads capped at 4 MB. Cloud
  Vercel production refuses.
- Reads: `GET /api/runs/:runId/evidence` lists a run's captures and the
  documents it handed over; `GET /api/captures/:id` serves one (byte ranges
  for video); `GET /api/captures/shared/:token` serves a shared one. Media is
  served with `nosniff` and a `sandbox` CSP.

Two capture paths use the daemon or the run-bound computer service. Native
Claude Code/Codex and GitHub requests use the machine's ordinary network and
selected credentials, as [orchestration](design/orchestration.md) defines.

| Where the thread runs | Tools | Path |
| --- | --- | --- |
| Local daemon (Playwright on the person's machine) | `submit_capture { path, title, steps? }` on the daemon's `mikka` MCP | The MCP copies a file from the worktree or the run's temp dir into the run dir; the daemon checks it again (no links, bytes, limit), then `POST /v1/runs/:runId/captures` → PUT to a presigned R2 URL (or the server without a bucket) → `POST …/:captureId/complete`, where the server re-reads the object and checks size, sha256 and type before it counts |
| Cloud computer | `capture_screenshot { title }`, `start_screen_recording { title, maxSeconds? }`, `stop_screen_recording {}`, `mark_recording_step { label }` on `mikka_computer` | The cloud worker relays the call to `POST /v1/runs/:runId/screen`; the server picks the desktop from the run's binding and runs `scripts/e2b/screen-capture.sh` (ffmpeg x11grab) in the sandbox through E2B |

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

A recording has a step timeline (Figma 13 「操作」). Each computer action
(`click`, `type_text`, `press_key`, `scroll`) carries a required `step`: what it
does in plain words for the person (「点击登录按钮」), never coordinates or a
tool name. The driver never sees it. While the broker's own recording window
is open (from `start_screen_recording`'s `stopsAt` until stop), it relays a
done action's step as `POST /v1/runs/:runId/screen {action:"step",label,source:"action",durationMs}`;
`durationMs` measures the action execution and excludes human approval waiting time.
`mark_recording_step` marks a moment that is not an action (`source:"mark"`).
The server masks the label like a title and keeps it in `run_capture_steps`
as an offset from `run_captures.startedAt` (set once ffmpeg is up), at most
200 per recording; with no recording going, nothing is kept. The Factory
evidence viewer lists the steps beside the video and seeks on click.

The daemon can resume an upload it registered while the run was active, even
after that run ends, while its 15-minute reservation is valid. A stop request
or revoked device credential still denies access. It cannot create a new
reservation after the run ends; an unregistered or expired file remains in
the local queue for inspection instead of being silently discarded.


### Factory visual handoff

Every implementation candidate needs a ready screenshot or video from its own
producer run. Video is the default for UI, backend, CLI and documentation work:
record the running app, actual test/API result, or rendered document respectively.
A report, logs, an old candidate's capture, or an `unverified` criterion cannot
replace visual evidence. Missing media commits a blocked state and returns
`factory_visual_evidence_required` at handoff, approval and merge entry points.
See [the visual-evidence decision](design/decisions/2026-11-08-2328-factory-visual-evidence-required.md).

The daemon and cloud recorder share `capture-video.mjs`. FFmpeg removes only
idle gaps established by complete action timing, preserves every action and
first/final state, and remaps step offsets. Older clips without durations keep
the full timeline. Inputs can be up to 1 GB; final MP4s remain at most 100 MB and
one hour for local captures (cloud recordings keep their existing 300-second
limit). Oversized output is recompressed with a bitrate budget and smaller
frame size, never truncated to fit. Processing failure publishes no ready file.
Local daemons need `ffmpeg` and `ffprobe` on PATH. Official cloud runtimes install
the paired tools under a versioned `/opt/mikka/runtime/capture-tools` directory
on both initial installation and worker staging. The source pins the upstream
asset IDs, compressed bytes and executable SHA-256 digests; installation verifies
them and leaves official files and system PATH unchanged. Both the daemon and
the standalone computer helper use that private pair. Cloud processing runs in
the existing computer, not the web server. No second media store is introduced.

`submit_capture` returns a stable `{captureId,status:"queued"}` before upload;
queued is not ready. The daemon drains captures before submitting completion,
and cloud completion awaits recording finalization. Independent application
instances serialize finalization through PostgreSQL so a second stop cannot
discard another instance's input or mark its valid output failed.
The terminal deadline cancels and drains hashing, processing and upload through
one abort signal. A failed publication retains its queue for recovery and cannot
be reported as a completed capture checkpoint.

Before PR publication, inspect the captured pixels for credentials and personal
data. Existing title, step and report masking does not redact pixels. Use safe
fixture data and submit only checked capture IDs in
`submit_result.visualEvidence: [{captureId,publicSafe:true}]`. The server accepts
no agent-supplied public URL and never shares undeclared historic media. It uses
the existing `run_capture_shares` links and records their candidate/digest receipt
in `factory_events`. Revocation blocks handoff and never silently creates a new
link. `factory_public_evidence_required` also blocks a repository candidate when
its current PR body has not acknowledged those exact links.

The host adds a managed `## Visual verification` block to the PR, preserving
human text and the final Mikka issue marker. The acceptance Artifact and task
conversation keep authenticated capture URLs. `FactoryFlowView.acceptance.media`
carries `captureId`, `kind`, `contentType`, `size`, `durationMs`, `url` and candidate
metadata for the existing clients' inline image/video rendering. The task's
[activity snapshot](factory/task-activity-v1.md) supplies its state and historical
submissions together. Clients identify a submission by task and activity item ID,
read media through its task media URL, and download reports at their submitted
Artifact version. Display titles and the Artifact's latest version are not
submission identities. These evidence reads grant no automatic merge authority.
