import { randomUUID } from "node:crypto"
import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk"
import { buildChildEnv } from "../env"
import { coordinatorDeadline, coordinatorSystemPrompt, CoordinatorToolHost, COORDINATOR_DEFAULT_TOOL_LIMIT, validateCoordinatorReply, type CoordinatorInput, type CoordinatorReply, type CoordinatorTool } from "./contract"

export interface ClaudeCoordinatorHost {
  /** A private host-managed directory, not a coding worktree. */
  cwd: string
  tools: readonly CoordinatorTool[]
  /** Host environment is filtered by the same allowlist as coding workers. */
  env?: NodeJS.ProcessEnv
  /** Tests may supply a protocol-compatible CLI; production uses the SDK's CLI. */
  executable?: string
}

export function claudeCoordinatorOptions(input: CoordinatorInput, host: ClaudeCoordinatorHost, controller: AbortController, tools: CoordinatorToolHost): Options {
  const registered = [...tools.tools.values()].map(definition => tool(
    definition.name, definition.description, definition.inputSchema,
    async (args, extra) => {
      const context = extra as { _meta?: { "claudecode/toolUseId"?: string } } | undefined
      // Some transports attach the native ID in metadata. Otherwise this ID
      // identifies only this invocation; durable effect identity belongs to the host.
      const callId = context?._meta?.["claudecode/toolUseId"] ?? randomUUID()
      try {
        const result = await tools.call(callId, definition.name, args)
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] }
      } catch {
        return { isError: true, content: [{ type: "text" as const, text: "Mikka tool failed or was refused. Do not repeat an action with an uncertain outcome." }] }
      }
    },
  ))
  const allowed = [...tools.tools.keys()].map(name => `mcp__mikka__${name}`)
  return {
    cwd: host.cwd,
    env: { ...buildChildEnv(host.env ?? process.env), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    systemPrompt: coordinatorSystemPrompt(input.instructions),
    settingSources: [],
    tools: [],
    // Let every MCP request reach canUseTool; bare allow rules bypass it.
    allowedTools: [],
    mcpServers: { mikka: createSdkMcpServer({ name: "mikka", tools: registered }) },
    strictMcpConfig: true,
    permissionMode: "default",
    canUseTool: async (name, args) => allowed.includes(name)
      ? { behavior: "allow", updatedInput: args }
      : { behavior: "deny", message: "Only Mikka's authorized Coordinator tools are available." },
    persistSession: false,
    maxTurns: (input.maxToolCalls ?? COORDINATOR_DEFAULT_TOOL_LIMIT) + 1,
    abortController: controller,
    ...(input.model ? { model: input.model } : {}),
    ...(host.executable ? { pathToClaudeCodeExecutable: host.executable } : {}),
  }
}

/** Runs one native SDK loop; no second model or post-processing LLM. */
export async function runClaudeCoordinator(input: CoordinatorInput, host: ClaudeCoordinatorHost): Promise<CoordinatorReply> {
  const deadline = coordinatorDeadline(input)
  let session: ReturnType<typeof query> | undefined
  try {
    deadline.controller.signal.throwIfAborted()
    const tools = new CoordinatorToolHost(host.tools, deadline.controller.signal, input.maxToolCalls ?? COORDINATOR_DEFAULT_TOOL_LIMIT)
    session = query({ prompt: input.context, options: claudeCoordinatorOptions(input, host, deadline.controller, tools) })
    for await (const message of session) {
      deadline.controller.signal.throwIfAborted()
      if (message.type !== "result") continue
      if (message.subtype !== "success" || message.is_error) throw new Error("coordinatorClaudeFailed")
      return { text: validateCoordinatorReply(message.result), nativeSessionId: message.session_id, toolCalls: tools.toolCalls }
    }
    throw new Error("coordinatorClaudeNoResult")
  } finally {
    session?.close()
    deadline.dispose()
  }
}
