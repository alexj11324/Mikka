import type { MessageConnection } from "vscode-jsonrpc/node"
import { z } from "zod"
import { coordinatorDeadline, coordinatorSystemPrompt, CoordinatorToolHost, COORDINATOR_DEFAULT_TOOL_LIMIT, validateCoordinatorReply, type CoordinatorInput, type CoordinatorReply, type CoordinatorTool } from "./contract"

/** Shared by process startup and thread creation; legacy `untrusted` fails in Codex 0.163. */
export const CODEX_COORDINATOR_APPROVAL_POLICY = "on-request" as const

/** A fresh isolated app-server connection. Closing it must kill its process group. */
export interface CodexCoordinatorHost {
  cwd: string
  tools: readonly CoordinatorTool[]
  connect(signal: AbortSignal): Promise<{ rpc: MessageConnection; close(): Promise<void> }>
}

export function codexCoordinatorThread(input: CoordinatorInput, host: Pick<CodexCoordinatorHost, "cwd">, tools: CoordinatorToolHost) {
  return {
    cwd: host.cwd,
    baseInstructions: coordinatorSystemPrompt(input.instructions),
    developerInstructions: "Mikka owns tools, memory, events and approval. Use the supplied dynamic tools for all external operations. Do not use coding-worker submit/handoff tools.",
    approvalPolicy: CODEX_COORDINATOR_APPROVAL_POLICY,
    sandbox: "read-only" as const,
    ephemeral: true,
    config: { "features.shell_tool": false, "features.multi_agent": false, "features.js_repl": false, web_search: "disabled", "apps._default.enabled": false },
    dynamicTools: [...tools.tools.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      inputSchema: z.toJSONSchema(z.object(definition.inputSchema).strict(), { target: "draft-7" }),
    })),
    ...(input.model ? { model: input.model } : {}),
  }
}

const toolRequest = z.object({ threadId: z.string(), turnId: z.string(), callId: z.string(), tool: z.string(), arguments: z.unknown() })

/** Native App Server owns the agent loop; Mikka handles only its tool requests. */
export async function runCodexCoordinator(input: CoordinatorInput, host: CodexCoordinatorHost): Promise<CoordinatorReply> {
  const deadline = coordinatorDeadline(input)
  const signal = deadline.controller.signal
  let transport: Awaited<ReturnType<CodexCoordinatorHost["connect"]>> | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  const messages = new Map<string, { text: string; phase?: string }>()
  let resolveEnd!: () => void
  let rejectEnd!: (error: Error) => void
  const ended = new Promise<void>((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject })
  // A transport can fail during the handshake before the turn is awaited.
  void ended.catch(() => undefined)
  let rejectAborted!: (error: Error) => void
  const cancellation = new Promise<never>((_, reject) => { rejectAborted = reject })
  void cancellation.catch(() => undefined)
  let acceptingTools = false
  const aborted = () => { rejectAborted(new Error("coordinatorCodexAborted")); rejectEnd(new Error("coordinatorCodexAborted")) }
  signal.addEventListener("abort", aborted, { once: true })
  try {
    signal.throwIfAborted()
    const tools = new CoordinatorToolHost(host.tools, signal, input.maxToolCalls ?? COORDINATOR_DEFAULT_TOOL_LIMIT)
    // connect must honor cancellation and kill a process it has partially started.
    transport = await host.connect(signal)
    signal.throwIfAborted()
    const { rpc } = transport
    rpc.onClose(() => rejectEnd(new Error("coordinatorCodexDisconnected")))
    rpc.onError(() => rejectEnd(new Error("coordinatorCodexTransportError")))
    rpc.onRequest("item/tool/call", async (raw: unknown) => {
      const parsed = toolRequest.safeParse(raw)
      if (!acceptingTools || !parsed.success || parsed.data.threadId !== threadId || (turnId && parsed.data.turnId !== turnId) || signal.aborted) {
        return { success: false, contentItems: [{ type: "inputText", text: "Mikka rejected this tool request." }] }
      }
      // A server can send requests before acknowledging turn/start. Pin the
      // first turn ID and verify the response agrees before accepting success.
      turnId ??= parsed.data.turnId
      try {
        const result = await tools.call(parsed.data.callId, parsed.data.tool, parsed.data.arguments)
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result ?? null) }] }
      } catch {
        return { success: false, contentItems: [{ type: "inputText", text: "Mikka tool failed or was refused. Do not repeat an uncertain action." }] }
      }
    })
    rpc.onRequest("item/commandExecution/requestApproval", () => ({ decision: "decline" }))
    rpc.onRequest("item/fileChange/requestApproval", () => ({ decision: "decline" }))
    rpc.onRequest("item/permissions/requestApproval", () => ({ permissions: {}, scope: "turn" }))
    rpc.onRequest("tool/requestUserInput", () => ({ answers: {} }))
    rpc.onRequest("item/tool/requestUserInput", () => ({ answers: {} }))
    rpc.onRequest("mcpServer/elicitation/request", () => ({ action: "decline", content: null }))
    rpc.onNotification("item/completed", (raw: unknown) => {
      const parsed = z.object({ threadId: z.string(), turnId: z.string(), item: z.object({ id: z.string(), type: z.string(), text: z.string().optional(), phase: z.string().nullable().optional() }) }).safeParse(raw)
      if (!parsed.success || parsed.data.threadId !== threadId || (turnId && parsed.data.turnId !== turnId)) return
      turnId ??= parsed.data.turnId
      const item = parsed.data.item
      if (item.type === "agentMessage" && item.text) {
        if (item.text.length > 200_000 || messages.size >= 200) { rejectEnd(new Error("coordinatorReplyTooLarge")); return }
        messages.set(item.id, { text: item.text, phase: item.phase ?? undefined })
      }
    })
    rpc.onNotification("turn/completed", (raw: unknown) => {
      const parsed = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) }).safeParse(raw)
      if (!parsed.success || parsed.data.threadId !== threadId || (turnId && parsed.data.turn.id !== turnId)) return
      turnId ??= parsed.data.turn.id
      acceptingTools = false
      if (parsed.data.turn.status === "completed") resolveEnd()
      else rejectEnd(new Error("coordinatorCodexTurnFailed"))
    })
    rpc.listen()
    const request = <T>(method: string, params: unknown) => Promise.race([rpc.sendRequest<T>(method, params), cancellation, ended.then(() => new Promise<never>(() => undefined))])
    await request("initialize", { clientInfo: { name: "mikka_coordinator", version: "1.0.0" }, capabilities: { experimentalApi: true } })
    await rpc.sendNotification("initialized")
    const thread = await request<{ thread: { id: string } }>("thread/start", codexCoordinatorThread(input, host, tools))
    threadId = z.string().min(1).parse(thread.thread.id)
    acceptingTools = true
    const turn = await request<{ turn: { id: string } }>("turn/start", { threadId, input: [{ type: "text", text: input.context, text_elements: [] }] })
    if (turnId && turnId !== turn.turn.id) throw new Error("coordinatorCodexTurnMismatch")
    turnId = z.string().min(1).parse(turn.turn.id)
    await Promise.race([ended, cancellation])
    signal.throwIfAborted()
    const items = [...messages.values()]
    // Commentary is progress, not the final personal-assistant response.
    const final = items.filter(item => item.phase === "final_answer")
    const text = final.length ? final.map(item => item.text).join("\n") : items.filter(item => !item.phase).at(-1)?.text ?? ""
    return { text: validateCoordinatorReply(text), nativeSessionId: threadId, toolCalls: tools.toolCalls }
  } finally {
    acceptingTools = false
    signal.removeEventListener("abort", aborted)
    try { await transport?.close() } finally { deadline.dispose() }
  }
}
