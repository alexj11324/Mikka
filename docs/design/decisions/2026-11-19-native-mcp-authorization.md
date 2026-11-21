# Authorized MCP connections run without a second decision

- Date: 2026-11-19
- Source: Alex, reviewing the Capy settings comparison, 「现在早就不需要使用 decision 进行判断了呀」.
- Supersedes the app-action controls in [Workspace app permissions](2026-11-10-1730-workspace-app-permissions.md) and the [app-write Decision fallback](2026-11-01-1330-write-judgment-unavailable-goes-ahead.md).

An enabled, authorized connection makes its configured tools available to the Agent. Provider credentials, resource access, workspace sharing, and current execution scope govern what the Agent can use. Mikka does not run a separate Decision API judgment or consult a workspace Allow/Ask/Deny matrix for each connected-app call. This applies to native MCP, Composio-backed calls, GitHub MCP and Mikka's connected-app operations.

The former app and run permissions page displays workspace run rules only. Manage connections where they are configured. Explicit approval records already created keep their exact input and account bindings. Pending operations with a numeric policy version retain that recorded authorization contract. Eve receipts prepared under an earlier plan reject execution if the plan digest changes. An uncertain invocation is never resent automatically.

Device controls, workspace connection access, browser and credential authorization, and Decision calls for other product features have their existing scope.

The reference is [Capy MCP settings](https://docs.capy.ai/integrations/mcp), which uses connection ownership, enabled state, project scope and provider sign-in for availability. Capy's optional tool visibility control is separate from executing an authorized call.
