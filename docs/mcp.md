# Mikka MCP server

Agents such as Claude Code and Codex can drive Mikka through its MCP server at
`https://app.aspectlylabs.com/mikka/api/mcp` (Streamable HTTP).

## Connecting

Claude Code:

```sh
claude mcp add --transport http mikka https://app.aspectlylabs.com/mikka/api/mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.mikka]
url = "https://app.aspectlylabs.com/mikka/api/mcp"
```

then `codex mcp login mikka`.

The first connection opens a browser: sign in to Mikka and allow the agent.
The agent then acts as you.

## Tools

| Tool | What it does |
| --- | --- |
| `send_to_coordinator` | Sends a message to your Coordinator, as if typed in the chat, and wakes it. Returns `after`. |
| `read_coordinator_messages` | Reads the conversation after a position; `waitSeconds` waits for the Coordinator's reply. |
| `list_issues`, `get_issue` | Your issues, and one issue with its text and latest runs. |
| `list_runs`, `get_run` | Recent agent runs, and one run with its summary and latest events. |

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

Each call writes one event with the run's `userId`, `runId` and `issueId` and
wakes the Coordinator. Tokens are stored hashed (`run_tokens`,
`drizzle/0012_run_tokens.sql`), live at most 24 hours, work only while the run
is live, and are revoked when the run completes.
