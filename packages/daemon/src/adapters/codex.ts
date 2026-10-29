import { sandboxComputerSpec, computerSandboxPolicy, computerDomain } from '../computer/transport'
// Codex adapter (ADR 0003): the user's own signed-in `codex app-server`,
// one process per session, inside the run's sandbox, with an isolated
// `CODEX_HOME` (see `agents/harness-home.ts`). Thread = session: `thread/start`
// or `thread/resume`, then `turn/start`; a message during a turn is a
// `turn/steer`, one between turns starts the next turn. Threads live in the
// run's `CODEX_HOME`, so a follow-up run copies the earlier run's
// `sessions` into its own before `thread/resume`.
import { isAbsolute, join, relative } from "node:path"

import type { MessageConnection } from "vscode-jsonrpc/node"

import {
  claimRunDir,
  endedSession,
  EventQueue,
  errorMessage,
  spawnCli,
  untilReady,
} from "../agents/child"
import {
  carryHistory,
  guardCodexAuth,
  prepareCodexHome,
} from "../agents/harness-home"
import { jsonlConnection } from "../agents/jsonl-rpc"
import {
  MCP_SERVER_NAME,
  COMPUTER_MCP_SERVER_NAME,
  RESUME_MESSAGE,
  RunContext,
  runPaths,
  type McpServerSpec,
  type ComputerSpecProvider,
} from "../agents/run-context"
import type { AgentSandbox } from "../agents/sandbox"
import { requireRunToolApproval } from "../agents/tool-approval"
import { spawnRunSandbox } from "../agents/run-sandbox-launcher"
import { runNetworkApproval } from "../agents/run-network"
import { rawCliShellAvailable, runPolicy } from "../permissions"
import type { RunChunk } from "../chunks"
import { DAEMON_VERSION } from "../paths"
import { buildChildEnv } from "../env"
import { mailboxToolResult } from '../run-mailbox'
import type {
  DeltaNotification,
  ErrorNotification,
  ItemNotification,
  ThreadItem,
  ThreadResponse,
  ThreadStartParams,
  TokenUsageNotification,
  TurnNotification,
  UserInput,
  ChatGPTAuthTokens
} from "./codex-protocol"
import type {
  AgentAdapter,
  AgentSession,
  SessionOptions,
  StartOptions,
} from "./types"

export interface CodexAdapterOptions {
  sandbox: AgentSandbox
  /** Optional host-owned additional ceiling; conservative intersection only. */
  networkCeiling?: readonly string[]
  /** The daemon's adapter state dir (per-run dirs and homes live under it). */
  stateDir: string
  binary?: string
  /** Trusted hosted transport, retaining the existing app-server adapter. */
  spawnCli?: typeof spawnCli
  /** Persist an owner-bound session before any prompt can execute. */
  onHostedSession?(sessionId:string):Promise<void>
  /** Supplied only by trusted hosted infrastructure for this run. */
  computerMcp?: McpServerSpec
  computerProvider?: ComputerSpecProvider
  /** The user's own `CODEX_HOME` (for the auth link); `~/.codex` by default. */
  userHome?: string
  /** Trusted, owner-bound broker only; never a task/model-supplied credential. */
  subscriptionAuth?: {
    accountId: string
    verify?(): Promise<void>
    /** `true` handles the official app-server's explicit token-refresh request. */
    token(forceRefresh: boolean): Promise<ChatGPTAuthTokens>
  }
}

const SUBSCRIPTION_AUTH_ERROR = "Codex subscription authentication unavailable"
const SUBSCRIPTION_EXECUTION_ERROR = "Codex subscription execution failed"

function subscriptionTokens(
  value: ChatGPTAuthTokens,
  accountId: string
): ChatGPTAuthTokens {
  if (
    !value ||
    value.chatgptAccountId !== accountId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(accountId) ||
    typeof value.accessToken !== "string" ||
    value.accessToken.length < 1 ||
    value.accessToken.length > 32768 ||
    /[\r\n\0]/.test(value.accessToken) ||
    (value.chatgptPlanType !== undefined &&
      (typeof value.chatgptPlanType !== "string" ||
        !/^[A-Za-z0-9 _-]{1,40}$/.test(value.chatgptPlanType)))
  )
    throw new Error(SUBSCRIPTION_AUTH_ERROR)
  // Select fields explicitly: refresh/ID tokens and arbitrary metadata never cross.
  return {
    accessToken: value.accessToken,
    chatgptAccountId: accountId,
    ...(value.chatgptPlanType ? { chatgptPlanType: value.chatgptPlanType } : {})
  }
}

/** What a follow-up run copies from the earlier run's `CODEX_HOME`. */
const CODEX_HISTORY = ["sessions", "archived_sessions", "session_index.jsonl"]

/** TOML value for a `-c key=value` override (JSON strings are TOML strings). */
function toml(value: string | string[]): string {
  return JSON.stringify(value)
}

function text(value: string): UserInput[] {
  return [{ type: "text", text: value, text_elements: [] }]
}

/** Codex thread items as UI message chunks, at item start and completion. */
export function codexItemChunks(
  phase: "started" | "completed",
  item: ThreadItem,
  streamed: Set<string>,
  worktree: string,
): RunChunk[] {
  switch (item.type) {
    case "agentMessage": {
      const message = item as Extract<ThreadItem, { type: "agentMessage" }>
      if (phase === "started") return []
      if (streamed.has(item.id)) return [{ type: "text-end", id: item.id }]
      return message.text
        ? [
            { type: "text-start", id: item.id },
            { type: "text-delta", id: item.id, delta: message.text },
            { type: "text-end", id: item.id },
          ]
        : []
    }
    case "reasoning":
      return phase === "completed" && streamed.has(item.id)
        ? [{ type: "reasoning-end", id: item.id }]
        : []
    case "commandExecution": {
      const command = item as Extract<ThreadItem, { type: "commandExecution" }>
      return phase === "started"
        ? [
            {
              type: "tool-input-available",
              toolCallId: item.id,
              toolName: "bash",
              input: { command: command.command },
            },
          ]
        : [
            {
              type: "tool-output-available",
              toolCallId: item.id,
              output: {
                exitCode: command.exitCode,
                output: (command.aggregatedOutput ?? "").slice(-4000),
              },
            },
          ]
    }
    case "fileChange": {
      const change = item as Extract<ThreadItem, { type: "fileChange" }>
      if (phase === "started") {
        return [
          {
            type: "tool-input-available",
            toolCallId: item.id,
            toolName: "apply_patch",
            input: { files: change.changes.map((c) => c.path) },
          },
        ]
      }
      return [
        {
          type: "tool-output-available",
          toolCallId: item.id,
          output: { status: change.status },
        },
        ...change.changes.map((c): RunChunk => ({
          type: "data-file-change",
          data: {
            // Codex reports absolute paths; runs report worktree-relative ones.
            path: isAbsolute(c.path) ? relative(worktree, c.path) : c.path,
            change:
              c.kind.type === "add"
                ? "added"
                : c.kind.type === "delete"
                  ? "deleted"
                  : "modified",
          },
        })),
      ]
    }
    case "mcpToolCall": {
      const call = item as Extract<ThreadItem, { type: "mcpToolCall" }>
      if (phase === "started") {
        return [
          {
            type: "tool-input-available",
            toolCallId: item.id,
            toolName: `mcp__${call.server}__${call.tool}`,
            input: call.arguments ?? {},
          },
        ]
      }
      return [
        call.error
          ? {
              type: "tool-output-error",
              toolCallId: item.id,
              errorText: call.error.message,
            }
          : {
              type: "tool-output-available",
              toolCallId: item.id,
              output: call.result?.content ?? [],
            },
      ]
    }
    default:
      return []
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly harness = "codex" as const
  readonly capabilities = { supportsInterject: true, supportsResume: true }
  readonly envAllow: readonly string[] = []

  constructor(private readonly options: CodexAdapterOptions) {}

  start(options: StartOptions): Promise<AgentSession> {
    const continued = options.continueSession
    if (options.requireSessionResume && !continued)
      return Promise.reject(
        new Error("Original Codex question session is required"),
      )
    return continued
      ? this.open(continued.sessionId, "continue", continued.message, options)
      : this.open(null, "new", options.prompt, options)
  }

  resume(sessionId: string, options: SessionOptions): Promise<AgentSession> {
    return this.open(sessionId, "restart", RESUME_MESSAGE, options)
  }

  /**
   * `restart`: this run's own thread after a daemon restart. `continue`:
   * an earlier run's thread, for a follow-up run; when `thread/resume`
   * fails, a new thread gets the full brief instead.
   */
  private async open(
    threadId: string | null,
    mode: "new" | "restart" | "continue",
    firstMessage: string,
    options: SessionOptions &
      Partial<Pick<StartOptions, "prompt" | "continueSession">>,
  ): Promise<AgentSession> {
    const approval = requireRunToolApproval(options.runId, options.toolApproval)
    if (!await approval.checkLive()) { approval.revoke(); throw new Error('Run tool approval unavailable') }
    const log = options.log.child({ harness: "codex" })
    if (options.mailbox && mode !== 'new') throw new Error('Run mailbox requires a fresh Codex thread; resume capability is unverified')
    const paths = runPaths(this.options.stateDir, options.runId)
    const runDir = await claimRunDir(paths)
    const externalAuth = this.options.subscriptionAuth
    if (externalAuth) {
      const clean = buildChildEnv({
        host: options.env,
        runId:
          options.env.MIKKA_RUN_ID === undefined ? undefined : options.runId
      })
      if (
        Object.entries(options.env).some(
          ([name, value]) => clean[name] !== value
        )
      )
        throw new Error(SUBSCRIPTION_AUTH_ERROR)
    }
    if (mode === "continue" && options.continueSession) {
      try {
        const earlier = runPaths(
          this.options.stateDir,
          options.continueSession.runId,
        ).runDir
        carryHistory(
          join(earlier, "codex-home"),
          join(runDir, "codex-home"),
          CODEX_HISTORY,
        )
      } catch (error) {
        if (options.requireSessionResume)
          throw new Error("Original Codex question history is unavailable", {
            cause: error,
          })
        log.info({ err: error }, "could not copy the earlier codex threads")
      }
    }
    // Inside the run dir: one run's home is never another run's.
    const codexHome = prepareCodexHome(
      join(runDir, "codex-home"),
      log,
      this.options.userHome,
      !externalAuth
    )
    const ctx = new RunContext({
      mailboxEnabled: Boolean(options.mailbox),
      harness: "codex",
      kind: options.kind,
      worktree: options.cwd,
      gitWritePaths: options.gitWritePaths,
      networkAllow: options.networkAllow,
      policy: options.policy,
      skills: options.skills,
      skillReceipt: options.skillReceipt,
      runDir,
      privateDir: paths.privateDir,
      extraWrite: codexHome.authFile ? [codexHome.authFile] : [],
    })
    // A hand-in the last daemon never got to act on ends the session now.
    const earlier = mode === "restart" ? ctx.readHandoff(log) : null
    if (threadId && earlier) return endedSession(threadId, earlier)
    ctx.clearHandoff()
    const computerMcp = sandboxComputerSpec(this.options.computerMcp ?? this.options.computerProvider?.(options.runId, options.policy), this.options.sandbox.kind)
    const mcp = ctx.mcpServer()
    const argv = [
      this.options.binary ?? "codex",
      "app-server",
      "-c", `features.shell_tool=${rawCliShellAvailable(runPolicy(options.policy))}`,
      "-c",
      `mcp_servers.${MCP_SERVER_NAME}.command=${toml(mcp.command)}`,
      "-c",
      `mcp_servers.${MCP_SERVER_NAME}.args=${toml(mcp.args)}`,
      ...Object.entries(mcp.env).flatMap(([key, value]) => [
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.env.${key}=${toml(value)}`,
      ]),
      ...(computerMcp ? [
        "-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.command=${toml(computerMcp.command)}`,
        "-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.args=${toml(computerMcp.args)}`,
        ...(computerMcp.env.MIKKA_COMPUTER_SANDBOX_PROXY === "1" ? [
          "-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.env_vars=["HTTP_PROXY","http_proxy"]`,
        ] : []),
        ...Object.entries(computerMcp.env).flatMap(([key, value]) => ["-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.env.${key}=${toml(value)}`]),
      ] : []),
      // Its shells get a filtered env; give them writable temp dirs.
      ...Object.entries(ctx.tempEnv()).flatMap(([key, value]) => [
        "-c",
        `shell_environment_policy.set.${key}=${toml(value)}`,
      ]),
    ]
    const checkAuth = guardCodexAuth(codexHome.authFile, log)
    const spawnOptions = {
      cwd: ctx.worktree,
      env: { ...options.env, ...ctx.tempEnv(), CODEX_HOME: codexHome.home },
      policy: computerSandboxPolicy(ctx.policy(), computerMcp),
      pidFile: paths.pidFile,
      marker: ctx.runDir,
    }
    const requestedCeiling = this.options.networkCeiling
    const maximum = requestedCeiling === undefined ? spawnOptions.policy.allowDomains
      : spawnOptions.policy.allowDomains.includes('*') ? [...requestedCeiling]
      : requestedCeiling.includes('*') ? spawnOptions.policy.allowDomains
      : requestedCeiling.filter(domain => spawnOptions.policy.allowDomains.includes(domain))
    let launcher: ReturnType<typeof spawnRunSandbox> | undefined
    const child = this.options.spawnCli || this.options.sandbox.kind === 'none'
      ? await (this.options.spawnCli ?? spawnCli)(this.options.sandbox, argv, spawnOptions)
      : (launcher = spawnRunSandbox({ command:argv[0], args:argv.slice(1), cwd:spawnOptions.cwd, env:spawnOptions.env, policy:spawnOptions.policy, maxAllowDomains:maximum, onNetwork:runNetworkApproval(options.runId,'codex',options.toolApproval!,maximum,computerDomain(computerMcp)) }))
    if (launcher) {
      const ownedLauncher = launcher
      const off = options.toolApproval!.onRevoke(() => { void ownedLauncher.revoke().catch(() => undefined) })
      void child.exited.finally(off)
    }
    // After the whole group is gone (`exited` kills it first).
    void child.exited.then(checkAuth)
    const rpc: MessageConnection = jsonlConnection(
      child.process.stdout,
      child.process.stdin,
    )
    const queue = new EventQueue()
    const streamed = new Set<string>()
    const pending: string[] = []
    let activeTurn: string | null = null
    let pendingTurnStart: Promise<void> | null = null
    let ending = false
    let cancelling = false
    let lastError: string | undefined
    let usage = { inputTokens: 0, outputTokens: 0 }
    const pendingMcp = new Map<string,{turnId:string;server:string;tool:string;attempted:boolean}>()
    const registeredMcpTool = (server: string, tool: string) =>
      (server === MCP_SERVER_NAME && ['submit','ask_human','report_blocked'].includes(tool)) ||
      (Boolean(computerMcp) && server === COMPUTER_MCP_SERVER_NAME && ['get_desktop_state','click','type_text','press_key','scroll'].includes(tool))

    /** The CLI and everything it started are gone before the exit is told. */
    let ended: Promise<void> | undefined
    const finish = (event: Parameters<EventQueue["exit"]>[0] | null) => {
      if (ended) return ended
      ending = true
      // Publish before close revokes the gate: an owner revocation listener
      // can synchronously re-enter cancel(), which must join this outcome.
      ended = Promise.resolve().then(() => close(event))
      return ended
    }
    const close = async (event: Parameters<EventQueue["exit"]>[0] | null) => {
      ending = true
      pendingMcp.clear()
      options.toolApproval?.revoke()
      if (pending.length > 0)
        log.warn(
          { dropped: pending.length },
          "session ended with unsent messages",
        )
      rpc.dispose()
      await child.kill()
      if (event) queue.exit(event)
    }

    // Native requests retain their active turn identity and live run gate;
    // callbacks cannot widen the enclosing sandbox's capability ceiling.
    rpc.onRequest(async (method, params: unknown) => {
      if (method === 'mcpServer/elicitation/request') {
        if (pendingTurnStart) await pendingTurnStart
        const call = params as {threadId?:unknown;turnId?:unknown;serverName?:unknown;mode?:unknown;_meta?:{codex_approval_kind?:unknown};requestedSchema?:{type?:unknown;properties?:unknown}} | null
        const schema = call?.requestedSchema, properties = schema?.properties
        // Codex's native transport approval is not the broker's action ask.
        // Bind only an already observed fixed host tool to this live turn;
        // human-readable elicitation messages never select authority.
        if (!call || ending || !activeTurn || call.threadId !== sessionId || call.turnId !== activeTurn ||
          call.mode !== 'form' || call._meta?.codex_approval_kind !== 'mcp_tool_call' ||
          !schema || schema.type !== 'object' || Object.keys(schema).some(key => !['type','properties'].includes(key)) ||
          !properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length) return {action:'decline'}
        const candidates = [...pendingMcp.entries()].filter(([,item]) => item.turnId === activeTurn && item.server === call.serverName && !item.attempted)
        if (candidates.length !== 1) return {action:'decline'}
        const [itemId,item] = candidates[0]
        item.attempted = true // repeated native requests never mint another permit
        const decision = await approval.request({runId:options.runId,harness:'codex',requestId:`${activeTurn}/${itemId}/mcp-transport`,method:`cli/mcp__${item.server}__${item.tool}`,input:{} })
        return decision === 'allow' && !ending && !approval.revoked && call.turnId === activeTurn && pendingMcp.get(itemId) === item
          ? {action:'accept',content:{}} : {action:'decline'}
      }
      if (method === 'item/tool/call') {
        if (pendingTurnStart) await pendingTurnStart
        const call = params as { threadId?: unknown; turnId?: unknown; namespace?: unknown; tool?: unknown; arguments?: unknown }
        const valid = options.mailbox && !ending && call.threadId === sessionId && call.turnId === activeTurn && activeTurn !== null && call.namespace === null && typeof call.tool === 'string'
        const result = valid ? mailboxToolResult(await options.mailbox!.request({ operation: 'call', name: call.tool, arguments: call.arguments })) : { isError: true, content: [{ type: 'text' as const, text: 'Run mailbox scope unavailable' }] }
        return { contentItems: result.content.map(part => ({ type: 'inputText', text: part.text })), success: !result.isError }
      }
      if (method === "account/chatgptAuthTokens/refresh") {
        const previous =
          params && typeof params === "object" && "previousAccountId" in params
            ? params.previousAccountId
            : undefined
        if (!externalAuth || previous !== externalAuth.accountId) {
          void finish({ outcome: "failed", error: SUBSCRIPTION_AUTH_ERROR })
          throw new Error(SUBSCRIPTION_AUTH_ERROR)
        }
        try {
          return subscriptionTokens(
            await externalAuth.token(true),
            externalAuth.accountId
          )
        } catch {
          void finish({ outcome: "failed", error: SUBSCRIPTION_AUTH_ERROR })
          throw new Error(SUBSCRIPTION_AUTH_ERROR)
        }
      }
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        if (!options.toolApproval) return { decision: "decline" }
        if (pendingTurnStart) await pendingTurnStart
        const call = params as { threadId?: unknown; turnId?: unknown; itemId?: unknown; approvalId?: unknown; grantRoot?: unknown; availableDecisions?: unknown } | null
        if (!call || ending || call.threadId !== sessionId || call.turnId !== activeTurn || typeof call.itemId !== 'string' || !activeTurn) return { decision: "decline" }
        // A grantRoot can widen writes for a session; this bridge grants only
        // one exact operation. Never convert it into a session-wide grant.
        if (method === 'item/fileChange/requestApproval' && call.grantRoot != null) return { decision: 'cancel' }
        if (call.availableDecisions != null && (!Array.isArray(call.availableDecisions) || !call.availableDecisions.includes('accept'))) return { decision: 'cancel' }
        if (call.approvalId != null && (typeof call.approvalId !== 'string' || !call.approvalId)) return { decision: 'decline' }
        const callbackId = typeof call.approvalId === 'string' ? call.approvalId : call.itemId
        const decision = await options.toolApproval.request({ runId: options.runId, harness: 'codex', requestId: `${activeTurn}/${call.itemId}/${callbackId}`, method, input: params })
        // Do not grant a session or policy amendment in place of one action.
        return { decision: decision === 'allow' && !options.toolApproval.revoked && !ending && call.turnId === activeTurn ? 'accept' : 'decline' }
      }
      if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" }
      log.warn({ method }, "unhandled codex request; declining")
      return { decision: "decline" }
    })
    rpc.onNotification((method: string, params: unknown) => {
      // A subagent/late foreign thread cannot rewrite the authority of this
      // host-bound run. Turn authority comes from our turn/start response.
      if (options.mailbox && (method.startsWith('item/') || method.startsWith('turn/') || method === 'thread/tokenUsage/updated') && (params as { threadId?: unknown } | null)?.threadId !== sessionId) return
      switch (method) {
        case "item/agentMessage/delta": {
          const { itemId, delta } = params as DeltaNotification
          if (!streamed.has(itemId)) {
            streamed.add(itemId)
            queue.chunk({ type: "text-start", id: itemId })
          }
          queue.chunk({ type: "text-delta", id: itemId, delta })
          return
        }
        case "item/reasoning/summaryTextDelta": {
          const { itemId, delta } = params as DeltaNotification
          if (!streamed.has(itemId)) {
            streamed.add(itemId)
            queue.chunk({ type: "reasoning-start", id: itemId })
          }
          queue.chunk({ type: "reasoning-delta", id: itemId, delta })
          return
        }
        case "item/started":
        case "item/completed": {
          const phase = method === "item/started" ? "started" : "completed"
          const { item, threadId: itemThread, turnId: itemTurn } = params as ItemNotification
          if (item.type === 'mcpToolCall' && itemThread === sessionId && typeof itemTurn === 'string') {
            const mcpItem = item as Extract<ThreadItem,{type:'mcpToolCall'}>
            if (phase === 'completed') pendingMcp.delete(item.id)
            else if (!pendingMcp.has(item.id) && pendingMcp.size < 1024 && registeredMcpTool(mcpItem.server,mcpItem.tool))
              pendingMcp.set(item.id,{turnId:itemTurn,server:mcpItem.server,tool:mcpItem.tool,attempted:false})
          }
          for (const chunk of codexItemChunks(
            phase,
            item,
            streamed,
            ctx.worktree,
          ))
            queue.chunk(chunk)
          return
        }
        case "turn/started":
          if (!options.mailbox) activeTurn = (params as TurnNotification).turn.id
          return
        case "thread/tokenUsage/updated": {
          const { total } = (params as TokenUsageNotification).tokenUsage
          usage = {
            inputTokens: total.inputTokens,
            outputTokens: total.outputTokens,
          }
          return
        }
        case "error": {
          const { error, willRetry } = params as ErrorNotification
          if (!willRetry)
            lastError = externalAuth
              ? SUBSCRIPTION_EXECUTION_ERROR
              : `Codex: ${error.message}`
          return
        }
        case "turn/completed":
          if (options.mailbox && pendingTurnStart) {
            const completed = (params as TurnNotification).turn
            void pendingTurnStart.then(() => {
              if (!ending && completed.id === activeTurn) { activeTurn = null; return turnCompleted(completed) }
            }).catch(() => undefined)
            return
          }
          if (options.mailbox && (params as TurnNotification).turn.id !== activeTurn) return
          activeTurn = null
          void turnCompleted((params as TurnNotification).turn)
          return
        default:
          return
      }
    })
    rpc.listen()

    const turnCompleted = async (turn: TurnNotification["turn"]) => {
      for (const [id,item] of pendingMcp) if (item.turnId === turn.id) pendingMcp.delete(id)
      queue.chunk({
        type: "data-usage",
        data: {
          ...usage,
          // Priced later with the LiteLLM table (ADR 0003).
          costUsd: null,
          source: "codex app-server thread/tokenUsage",
        },
      })
      if (ending) return
      if (cancelling) return finish({ outcome: "cancelled" })
      const handoff = ctx.readHandoff(log)
      if (handoff) return finish(handoff)
      const next = pending.shift()
      if (next) {
        await startTurn(next).catch((error: unknown) =>
          finish({
            outcome: "failed",
            error: externalAuth
              ? SUBSCRIPTION_EXECUTION_ERROR
              : `Codex: ${errorMessage(error)}`
          })
        )
        return
      }
      if (turn.status === "failed" || lastError) {
        return finish({
          outcome: "failed",
          error: externalAuth
            ? SUBSCRIPTION_EXECUTION_ERROR
            : turn.error?.message
              ? `Codex: ${turn.error.message}`
              : lastError
        })
      }
      return finish({ outcome: "succeeded" })
    }

    let sessionId = threadId ?? ""
    let runtimeModel: string | null = null
    const startTurn = async (message: string) => {
      lastError = undefined
      if (externalAuth?.verify) {
        try { await externalAuth.verify() } catch { throw new Error(SUBSCRIPTION_AUTH_ERROR) }
      }
      const result = rpc.sendRequest<{ turn: { id: string } }>("turn/start", {
        threadId: sessionId,
        input: text(message)
      })
      const response = (externalAuth
        ? result.catch(() => {
            throw new Error(SUBSCRIPTION_EXECUTION_ERROR)
          })
        : result)
      if (options.mailbox) {
        pendingTurnStart = response.then(({ turn }) => { if (!ending) activeTurn = turn.id })
        try { await pendingTurnStart } finally { pendingTurnStart = null }
      } else { const { turn } = await response; activeTurn ??= turn.id }
    }

    void child.exited.then(({ code, signal }) => {
      if (ending) return
      ending = true
      rpc.dispose()
      if (cancelling) return queue.exit({ outcome: "cancelled" })
      const handoff = ctx.readHandoff(log)
      if (handoff) return queue.exit(handoff)
      queue.exit({
        outcome: "failed",
        error: externalAuth
          ? SUBSCRIPTION_EXECUTION_ERROR
          : `codex app-server exited (${signal ?? code}): ${child.stderrTail() || "no output"}`
      })
    })

    const ready = <T,>(step: Promise<T>, label: string) =>
      untilReady(child, step, `codex ${label}`)
    try {
      const initialized = await ready(
        rpc.sendRequest<{ userAgent?: string }>("initialize", {
          clientInfo: {
            name: "mikka",
            title: "Mikka",
            version: DAEMON_VERSION,
          },
          capabilities: externalAuth || options.mailbox ? { experimentalApi: true } : null
        }),
        "initialize",
      )
      // Public schemas omit the experimental dynamicTools field. Support only
      // the exact pinned CLI whose Rust protocol and response were audited.
      if ((options.mailbox || !rawCliShellAvailable(runPolicy(options.policy))) && !/(?:^|[ /])0\.163\.0(?:$|[ ();])/.test(initialized.userAgent ?? '')) throw new Error('Run permissions require the audited Codex0.163.0 tool interface')
      await rpc.sendNotification("initialized")
      if (externalAuth) {
        try {
          const auth = subscriptionTokens(
            await externalAuth.token(false),
            externalAuth.accountId
          )
          const loggedIn = await ready(
            rpc.sendRequest<{ type: string }>("account/login/start", {
              type: "chatgptAuthTokens",
              ...auth
            }),
            "subscription login"
          )
          if (loggedIn.type !== "chatgptAuthTokens")
            throw new Error(SUBSCRIPTION_AUTH_ERROR)
        } catch {
          throw new Error(SUBSCRIPTION_AUTH_ERROR)
        }
      }
      const thread: ThreadStartParams = {
        cwd: ctx.worktree,
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        developerInstructions: ctx.instructions(),
        ...(options.mailbox ? { dynamicTools: options.mailbox.tools.map(tool => ({ type: 'function' as const, ...tool })) } : {}),
        ...(options.model ? { model: options.model } : {}),
      }
      const newThread = () =>
        ready(
          rpc.sendRequest<ThreadResponse>("thread/start", thread),
          "thread/start",
        )
      let response: ThreadResponse
      if (!threadId) response = await newThread()
      else {
        try {
          response = await ready(
            rpc.sendRequest<ThreadResponse>("thread/resume", {
              ...thread,
              threadId,
            }),
            "thread/resume",
          )
        } catch (error) {
          if (externalAuth || mode !== "continue" || ending || options.requireSessionResume) throw error
          log.info(
            { err: error, thread_id: threadId },
            "could not continue the earlier codex thread; starting a new one",
          )
          mode = "new"
          firstMessage = options.prompt ?? firstMessage
          response = await newThread()
        }
      }
      sessionId = response.thread.id
      runtimeModel = typeof response.model === "string" && response.model ? response.model : null
      if (runtimeModel) options.onRuntimeModel?.(sessionId, runtimeModel)
      if (options.requireSessionResume && sessionId !== threadId)
        throw new Error("Codex resumed a different question thread")
      if(externalAuth)await this.options.onHostedSession?.(sessionId)
      await ready(startTurn(firstMessage), "turn/start")
    } catch (error) {
      await finish(null)
      if (externalAuth) throw new Error(SUBSCRIPTION_AUTH_ERROR)
      throw new Error(
        `Could not start codex app-server: ${errorMessage(error)}. ${child.stderrTail()}`.trim(),
        { cause: error },
      )
    }
    log.info({ session_id: sessionId, mode }, "codex session started")

    return {
      sessionId,
      runtimeModel,
      events: () => queue.drain(),
      async send(message) {
        if (ending) throw new Error("The Codex session already ended")
        if (activeTurn) {
          try {
            await rpc.sendRequest("turn/steer", {
              threadId: sessionId,
              input: text(message),
              expectedTurnId: activeTurn,
            })
            return
          } catch {
            // The turn ended in between: the message starts the next one.
          }
        }
        if (activeTurn) pending.push(message)
        else await startTurn(message)
      },
      async cancel() {
        // Revoking the gate tears down the owned proxy/CLI immediately. Mark
        // intent first so that child exit or turn/completed cannot win the
        // race and report a successful/failed run for this cancellation.
        cancelling = true
        options.toolApproval?.revoke()
        if (activeTurn && !ending) {
          await rpc
            .sendRequest("turn/interrupt", {
              threadId: sessionId,
              turnId: activeTurn,
            })
            .catch(() => undefined)
        }
        await finish({ outcome: "cancelled" })
      },
      async detach() {
        options.toolApproval?.revoke()
        await finish(null)
      },
    }
  }
}
