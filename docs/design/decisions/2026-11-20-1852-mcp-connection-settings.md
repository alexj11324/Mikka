# MCP connection settings

Issue: #2956 P4. The connection owner manages authentication, tools and runtime
environment scope. Workspace membership alone never grants a connection; the
existing explicit share and organization policy still decide visibility.

Connection checks reuse the existing MCP SDK handshake. Tool descriptions are
untrusted evidence and credentials are removed before snapshots are persisted.
Disabling a tool is enforced by the existing remote runtime and by the native
tool filters supplied to Eve, Claude Code and Codex. There is no per-call Decision
approval and no replacement MCP client or generic proxy.

OAuth authorization-code, PKCE, discovery, issuer binding and refresh use
`@ai-sdk/mcp`'s `auth()` and `OAuthClientProvider`. Mikka owns session-bound,
single-use state and encrypted persistence. The browser receives an authorization
URL, never access or refresh tokens. Shared members cannot start/check or change
another person's connection and cannot see disabled tools or endpoint secrets.

Environment IDs are checked against the existing workspace environments in their
owning database. An empty binding list retains the existing authorized workspace
scope; it does not create a share. Bound connections are available only in a
matching environment and still require the frozen resource grant.

Migration rollback is an application-code rollback, retaining the additive
columns and tables. Removing persisted credentials requires a separate reviewed
migration. Acceptance uses local PG17 and HTTP OAuth/MCP fixtures, with no real
model or provider calls.
