# MCP connection settings

Issue: #2956 P4. The connection owner manages authentication, tools and runtime
environment scope. Workspace membership alone never grants a connection; the
existing explicit share and organization policy still decide visibility.

Connection checks reuse the existing MCP SDK handshake. Tool descriptions are
untrusted evidence and credentials are removed before snapshots are persisted.
Disabling a tool is enforced by the existing remote runtime and by the native
tool filters supplied to Eve, Claude Code and Codex. Cursor receives its native
`Mcp(server:tool)` deny rules. There is no per-call Decision approval and no
replacement MCP runtime or generic proxy.

HTTP and SSE checks run through the existing public transport. A STDIO check
requires an explicit `deviceId` for a local device owned by the connection owner.
The control plane stores only a five-minute request reference and uses the
existing device work push. A capable daemon reads the encrypted configuration
through its authenticated `/commands` response, uses the official MCP SDK for
one initialize/tools-list exchange, and returns a bounded `/report` receipt.
No tool execution or model request is part of a check. A removed device, another
owner/device, changed connection revision, expired request or consumed receipt
cannot update the catalogue. A device that never responds leaves an expired
attempt visible as `check_failed`; it never becomes connected by timeout.

Device completion publishes the existing owner/workspace live channel's
`integration_settings` key (id = workspaceId), containing no server configuration.
The connection detail's `deviceCheck` includes the request id, selected device,
expiry and pending/expired status. The frontend can show the deadline locally
and re-read on this invalidation without introducing polling. Older daemons do
not advertise `x-mikka-mcp-check: 1` and receive no new command payload.

OAuth authorization-code, PKCE, discovery, issuer binding and refresh use
`@ai-sdk/mcp`'s `auth()` and `OAuthClientProvider`. Mikka owns session-bound,
single-use state and encrypted persistence. The browser receives an authorization
URL, never access or refresh tokens. The callback checks the MCP connection after
the token exchange before reporting its connection status. Shared members cannot start/check or change
another person's connection and cannot see disabled tools or endpoint secrets.

Environment IDs are checked against the existing workspace environments in their
owning database. An empty binding list retains the existing authorized workspace
scope; it does not create a share. Bound connections are available only in a
matching environment and still require the frozen resource grant.

Migration rollback is an application-code rollback, retaining the additive
columns and tables. Removing persisted credentials requires a separate reviewed
migration. Acceptance uses local PG17 and HTTP OAuth/MCP fixtures, with no real
model or provider calls.
