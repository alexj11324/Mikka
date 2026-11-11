# eve owns generic Agent behavior; tasks receive native MCP configuration

- Date: 2026-11-11
- Source: [#1918](https://github.com/alexj11324/Mikka/issues/1918), Alex: 「我们的并不好用，所以 eve 有的功能，全部替换成他们的。」 Follow-up in the implementation conversation: 「mcp按照capy的办法去做，把1918和mcp的注入都实现了」。
- Rule: Agent runtime, client protocol, MCP configuration and task credential exposure.
- Replaces: retaining duplicated Mikka runtime/client features behind a thin eve model-loop wrapper. For **configured task MCP credentials only**, this also supersedes the protected/non-readable default in [credential exposure](2026-11-08-0240-credential-exposure-boundary.md). Other Secret classes retain that decision.

## Generic Agent behavior

Use a pinned upstream `eve` release and its public APIs. eve owns the Agent
loop, sessions, turn queue, replay, cancellation, compaction, skills, MCP
connections, subagent lifecycle, approvals and channel delivery wherever its
public API provides the capability. Browser, desktop and mobile consume one
eve-compatible protocol. Keep existing Mikka components for presentation.

Mikka retains authenticated users, Workspace membership, Bot/Task/Thread
ownership, policy choices, billing, credential custody and actual task
machines. Store the mapping from these product identities to eve sessions;
an opaque eve session ID is not authorization. Preserve historical chat rows
and import supported history rather than deleting conversations.

Do not retain an independently functioning old loop or permanent runtime
toggle. A required adapter documents the missing public eve equivalent and
tests the product boundary it preserves.

## Native MCP on a task machine

Configure authorized HTTP MCP endpoints and headers directly on the task's
official CLI. A configured STDIO server runs on that task's machine with its
command, arguments, working directory and environment. Its dependencies must
be available in the task environment. Keep unrelated native CLI configuration.

Select connections from the thread starter's personal connections plus the
Workspace connections explicitly shared with them. Respect enabled state,
project/Workspace scope and the selected connection revision when preparing
the assignment. Installing a connection does not grant unrelated resources.

The task Agent can read a credential configured in that machine's MCP client
or process environment. This is authorized exposure to the task, and must not
be described as non-readable. Exclude credentials from reusable images,
snapshots, public API listings, logs and reports. A directly delivered copy
cannot be revoked merely by hiding a connection in Mikka: revoke upstream
access or stop/reconfigure the task when immediate revocation is required.

Composio remains an application/OAuth provider. Its underlying service tokens
stay with Composio/Mikka; the native client gets the authorized tool endpoint,
not exported Composio account credentials. Use upstream eve/native client
execution and approval behavior, with Mikka's Workspace choices as policy
inputs, rather than a second generic tool implementation.

## Reference evidence

- [Capy MCP](https://docs.capy.ai/integrations/mcp): HTTP credentials in
  headers, STDIO processes on thread machines, personal/organization ownership
  and project scope. The page does not disclose the process holding remote
  HTTP OAuth tokens.
- [Capy Secrets](https://docs.capy.ai/secrets): machine environment injection
  and an explicit statement that code on the machine can read its variables.
- [LobeHub MCP](https://lobehub.com/docs/usage/community/mcp-market): native
  HTTP/STDIO configuration and Allow/Ask/Deny tool permissions.

This record defines the implementation target. Passing source tests, deployment
and real provider acceptance are recorded separately; this decision is not
evidence that the migration has shipped.
