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
