# The Coordinator uses GitHub's hosted MCP server with the person's own token

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: the Coordinator does GitHub
  operations directly through GitHub's official hosted MCP server with the
  person's own GitHub credential, and its Bot desktop's git and gh have that
  credential too.
- Rule: —
- Replaces: the `github_api` tool idea in
  [2026-11-02-1600-agents-use-own-github-credential](2026-11-02-1600-agents-use-own-github-credential.md)
  (never shipped); that decision's credential rules stand.

The Coordinator's direct GitHub operations (read issues, pull requests and CI;
comment; open or merge pull requests) go through `github_tools` and
`github_call`, which connect to `https://api.githubcopilot.com/mcp/` with the
caller's own GitHub App user token as `Authorization: Bearer`, its default
toolsets plus `actions`. Mikka writes no GitHub API wrapper of its own.

What follows:

- The token is resolved per call on the server for the caller only, refreshed
  through `githubTokenForUser`. It is never in the model context, chat, logs,
  errors or memory: results are redacted and credential-masked, and errors are
  codes (githubNotConnected, githubReconnectRequired, mcpUnavailable,
  mcpOutcomeUnknown).
- Dispatching to an Agent stays the default for work in code; the GitHub tools
  are a supplement. Scheduled read-only turns get neither tool, and an
  uncertain call is never retried automatically.
- A Bot's cloud desktop gets a git credential helper and gh wrapper that ask
  `POST /v1/devices/:deviceId/github-token` with the desktop worker's own
  device credential, which reaches only the desktop owner's token. The token is
  cached at most fifty minutes in a 0600 file that is a snapshot credential
  path, and is never in argv, git's environment or a command.
