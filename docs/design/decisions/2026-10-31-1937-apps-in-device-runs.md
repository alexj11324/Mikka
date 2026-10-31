# Connected apps in device runs

- Date: 2026-10-31
- Source: Alex, 2026-10-31: 「那你就按照这个最佳实践去做吧，指向我们的米卡就行了」
- Rule: —
- Replaces: —

When the daemon launches Claude Code or Codex for a Bot run, the run can use
the apps its owner connected in Mikka (Composio toolkits). Each app is its own
MCP entry, injected at launch only, the way CC Switch lays out servers: no hub
with list/call meta-tools, because the CLI's own MCP tool search discloses
tools per server. The daemon never writes `~/.claude.json` or
`~/.codex/config.toml`.

Every entry points at the Mikka server (`/api/runs/mcp/<toolkit>`), never at
Composio, whose session headers carry the project key. The entry authenticates
with the run's existing token: owner, Bot and run come from the token, it
expires and is revoked when the run ends, and the toolkit must be one the owner
connected and the Bot may use. Calls follow the cloud Bot's rules: explicit
allow/ask/deny first, and only destructive writes become an approval card.

The daemon allows `mcp__<toolkit>__*` only for the entries it registered for
that run. `WebFetch` and `WebSearch` follow the run's network permission
(allow / ask / deny); other unknown tools stay unavailable.
