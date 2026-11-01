import { sandboxComputerSpec, computerSandboxPolicy } from '../computer/transport'
// Cursor adapter (ADR 0003): the user's own signed-in Cursor CLI as an ACP
// agent (`agent acp`), one process per session, inside the run's sandbox,
// with an isolated `CURSOR_CONFIG_DIR` (its login stays in the Keychain).
// Any other ACP agent could use the same client code. ACP has no mid-turn
// input, so a message sent during a prompt is delivered as the next prompt.
// Chats live in the run's `CURSOR_DATA_DIR`, so a follow-up run copies the
// earlier run's chats into its own before `session/load`.
import { Readable, Writable } from "node:stream"

import * as acp from "@agentclientprotocol/sdk"
import { join } from "node:path"

import {
  claimRunDir,
  endedSession,
  EventQueue,
  errorMessage,
  spawnCli,
  untilReady,
} from "../agents/child"
import { carryHistory, prepareCursorHome } from "../agents/harness-home"
import {
  MCP_SERVER_NAME,
  COMPUTER_MCP_SERVER_NAME,
  RESUME_MESSAGE,
  RunContext,
  runPaths,
  type ComputerSpecProvider,
} from "../agents/run-context"
import type { AgentSandbox } from "../agents/sandbox"
import type { RunChunk } from "../chunks"
import {
  classifyCommand,
  decide,
  runPolicy,
  type PermissionDecision,
  type RunPolicy,
} from "../permissions"
import {
  COMMAND_ACTIONS,
  commandDigest,
  decisionFallback,
  judgeCommandAction,
  noServerDecision,
  type CommandAction,
} from "../decision-judgments"
import type { ServerDecide } from "../server-decision"
import { DAEMON_VERSION } from "../paths"
import type {
  AgentAdapter,
  AgentSession,
  SessionOptions,
  StartOptions,
} from "./types"

export interface CursorAdapterOptions {
  sandbox: AgentSandbox
  /** The daemon's adapter state dir (per-run dirs and homes live under it). */
  stateDir: string
  /** `agent` (or `cursor-agent`) on PATH by default. */
  binary?: string
  computerProvider?: ComputerSpecProvider
  /** The server's Decisions API for shell-command judgments; none means no answer. */
  decide?: ServerDecide
}

/**
 * Turns ACP session updates into UI message chunks. Consecutive message (or
 * thought) chunks share one text part until something else interrupts them.
 */
type PermissionRequest = Parameters<acp.Client["requestPermission"]>[0]
type PermissionResponse = Awaited<ReturnType<acp.Client["requestPermission"]>>

/** The Decisions API for one run's command judgments, cached by command digest. */
export interface CommandJudgment {
  decide: ServerDecide
  runId: string
  cwd?: string
  cache: Map<string, Promise<CommandAction | null>>
}

/**
 * The workspace decision for a shell command that is not `git push`. When
 * the person's settings give every action a command could be the same
 * decision, that decision stands and nothing is asked. Otherwise the
 * Decisions API names the action and its policy applies; no answer lets the
 * agent's command go ahead (logged), never a hardcoded classification.
 */
async function commandDecision(command: string, policy: RunPolicy, judgment: CommandJudgment | undefined): Promise<PermissionDecision> {
  const decisionFor = (action: CommandAction): PermissionDecision => action === "other" ? "allow" : decide(action, { policy })
  const decisions = new Set(COMMAND_ACTIONS.map(decisionFor))
  if (decisions.size === 1) return [...decisions][0]
  const digest = commandDigest(command)
  const cache = judgment?.cache
  let pending = cache?.get(digest)
  if (!pending) {
    pending = judgeCommandAction(judgment?.decide ?? noServerDecision, judgment?.runId ?? "", { command, cwd: judgment?.cwd, harness: "cursor" })
    cache?.set(digest, pending)
  }
  const action = await pending
  if (action) return decisionFor(action)
  if (cache?.get(digest) === pending) cache.delete(digest)
  decisionFallback(`cursor command ${digest.slice(0, 12)} allowed without a judgment`)
  return "allow"
}

/**
 * Answers Cursor's permission request for a tool call (ADR 0028). Mikka's
 * sandbox is the boundary, so tool calls are allowed, except a shell command
 * the workspace's policy does not allow once the Decisions API has named its
 * action (nobody can be asked mid-run, so `ask` is refused and the agent is
 * told to call `ask_human`) and `git push`, which only the daemon does
 * (ADR 0017) unless the agent delivers the run itself.
 */
export async function acpPermissionResponse(
  params: PermissionRequest,
  policy: RunPolicy | undefined,
  agentDelivers = false,
  judgment?: CommandJudgment
): Promise<{ response: PermissionResponse; refused: boolean }> {
  const pick = (kinds: readonly string[]): PermissionResponse => {
    for (const kind of kinds) {
      const option = params.options.find((o) => o.kind === kind)
      if (option)
        return { outcome: { outcome: "selected", optionId: option.optionId } }
    }
    return { outcome: { outcome: "cancelled" } }
  }
  const raw = params.toolCall.rawInput as { command?: unknown } | undefined
  const command = Array.isArray(raw?.command)
    ? raw.command.join(" ")
    : typeof raw?.command === "string"
      ? raw.command
      : (params.toolCall.title ?? "")
  const action = classifyCommand(command)
  // Only a shell command is judged; other tool calls stay inside the sandbox.
  const shell = Array.isArray(raw?.command) || typeof raw?.command === "string"
  const refused = action === "git_push"
    ? !agentDelivers || decide(action, { policy: runPolicy(policy) }) !== "allow"
    : shell && command.trim() !== "" && await commandDecision(command, runPolicy(policy), judgment) !== "allow"
  if (refused)
    return { response: pick(["reject_once", "reject_always"]), refused }
  const allowed = pick(["allow_always", "allow_once"])
  const first = params.options[0]
  return {
    response:
      allowed.outcome.outcome === "selected" || !first
        ? allowed
        : { outcome: { outcome: "selected", optionId: first.optionId } },
    refused,
  }
}

export class AcpChunker {
  private open: { kind: "text" | "reasoning"; id: string } | null = null
  private count = 0

  constructor(private readonly prefix: string) {}

  /** Closes an open text or reasoning part. */
  close(): RunChunk[] {
    if (!this.open) return []
    const { kind, id } = this.open
    this.open = null
    return [{ type: kind === "text" ? "text-end" : "reasoning-end", id }]
  }

  private part(kind: "text" | "reasoning", delta: string): RunChunk[] {
    const chunks: RunChunk[] = []
    if (this.open?.kind !== kind) {
      chunks.push(...this.close())
      const id = `${this.prefix}-${++this.count}`
      this.open = { kind, id }
      chunks.push({
        type: kind === "text" ? "text-start" : "reasoning-start",
        id,
      })
    }
    const id = this.open?.id as string
    chunks.push(
      kind === "text"
        ? { type: "text-delta", id, delta }
        : { type: "reasoning-delta", id, delta }
    )
    return chunks
  }

  update(update: acp.SessionNotification["update"]): RunChunk[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = update.content
        if (content.type !== "text" || !content.text) return []
        return this.part(
          update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning",
          content.text
        )
      }
      case "tool_call":
        return [
          ...this.close(),
          {
            type: "tool-input-available",
            toolCallId: update.toolCallId,
            toolName: update.kind ?? "tool",
            title: update.title,
            input: update.rawInput ?? { title: update.title },
          },
        ]
      case "tool_call_update": {
        if (update.status !== "completed" && update.status !== "failed")
          return []
        const output = update.rawOutput ?? toolText(update.content)
        return [
          ...this.close(),
          update.status === "failed"
            ? {
                type: "tool-output-error",
                toolCallId: update.toolCallId,
                errorText:
                  typeof output === "string" ? output : JSON.stringify(output),
              }
            : {
                type: "tool-output-available",
                toolCallId: update.toolCallId,
                output,
              },
        ]
      }
      default:
        return []
    }
  }
}

function toolText(content: acp.ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .map((item) =>
      item.type === "content" && item.content.type === "text"
        ? item.content.text
        : ""
    )
    .join("\n")
    .slice(-4000)
}

/** What a follow-up run copies from the earlier run's `CURSOR_DATA_DIR`. */
const CURSOR_HISTORY = ["chats", "projects"]

export class CursorAdapter implements AgentAdapter {
  readonly harness = "cursor" as const
  readonly capabilities = { supportsInterject: true, supportsResume: true }
  readonly envAllow: readonly string[] = []

  constructor(private readonly options: CursorAdapterOptions) {}

  start(options: StartOptions): Promise<AgentSession> {
    const continued = options.continueSession
    return continued
      ? this.open(continued.sessionId, "continue", continued.message, options)
      : this.open(null, "new", options.prompt, options)
  }

  resume(sessionId: string, options: SessionOptions): Promise<AgentSession> {
    return this.open(sessionId, "restart", RESUME_MESSAGE, options)
  }

  /**
   * `restart`: this run's own session after a daemon restart. `continue`:
   * an earlier run's session, for a follow-up run; when `session/load`
   * fails, a new session gets the full brief instead.
   */
  private async open(
    resumeId: string | null,
    mode: "new" | "restart" | "continue",
    firstMessage: string,
    options: SessionOptions &
      Partial<Pick<StartOptions, "prompt" | "continueSession">>
  ): Promise<AgentSession> {
    const log = options.log.child({ harness: "cursor" })
    const paths = runPaths(this.options.stateDir, options.runId)
    const runDir = await claimRunDir(paths)
    if (mode === "continue" && options.continueSession) {
      try {
        const earlier = runPaths(
          this.options.stateDir,
          options.continueSession.runId
        ).runDir
        carryHistory(
          join(earlier, "cursor-home"),
          join(paths.runDir, "cursor-home"),
          CURSOR_HISTORY
        )
      } catch (error) {
        log.info({ err: error }, "could not copy the earlier cursor chats")
      }
    }
    // Inside the run dir (writable): one run's home is never another run's,
    // and `session/load` finds the session again on resume.
    // The path as given, not its real path: with `/private/tmp/...` Cursor
    // 2026.09 stopped using CURSOR_DATA_DIR and wrote to `/tmp/.cursor`.
    const configDir = prepareCursorHome(join(paths.runDir, "cursor-home"))
    const ctx = new RunContext({
      github: options.github,
      childPath: options.env.PATH,
      harness: "cursor",
      kind: options.kind,
      worktree: options.cwd,
      gitWritePaths: options.gitWritePaths,
      networkAllow: options.networkAllow,
      policy: options.policy,
      policyHash: options.policyHash,
      skills: options.skills,
      skillReceipt: options.skillReceipt,
      runDir,
      privateDir: paths.privateDir,
    })
    // A hand-in the last daemon never got to act on ends the session now.
    const earlier = mode === "restart" ? ctx.readHandoff(log) : null
    if (resumeId && earlier) return endedSession(resumeId, earlier)
    ctx.clearHandoff()
    const computerMcp = sandboxComputerSpec(this.options.computerProvider?.(options.runId, options.policy), this.options.sandbox.kind)
    const argv = [
      this.options.binary ?? "agent",
      // Cursor's own sandbox cannot nest inside Mikka's.
      "--sandbox",
      "disabled",
      ...(options.model ? ["--model", options.model] : []),
      "acp",
    ]
    const child = await spawnCli(this.options.sandbox, argv, {
      cwd: ctx.worktree,
      env: {
        ...options.env,
        ...ctx.tempEnv(),
        CURSOR_CONFIG_DIR: configDir,
        // Its per-project store (MCP approvals, chats) lives here, not in ~/.cursor.
        CURSOR_DATA_DIR: configDir,
      },
      policy: computerSandboxPolicy(ctx.policy(), computerMcp),
      pidFile: paths.pidFile,
      marker: ctx.runDir,
    })
    const queue = new EventQueue()
    const judgment: CommandJudgment = { decide: this.options.decide ?? noServerDecision, runId: options.runId, cwd: ctx.worktree, cache: new Map() }
    const chunker = new AcpChunker("cursor")
    const pending: string[] = []
    let replaying = false
    let prompting = false
    let ending = false

    const conn = new acp.ClientSideConnection(
      () => ({
        // Mikka's sandbox decides, plus the workspace's command rules.
        async requestPermission(params) {
          const { response, refused } = await acpPermissionResponse(
            params,
            options.policy,
            ctx.agentDelivers,
            judgment
          )
          if (refused)
            log.info(
              { tool: params.toolCall.title },
              "tool call refused by the workspace's agent policy"
            )
          return response
        },
        async sessionUpdate(params) {
          if (replaying) return
          if (params.sessionId === sessionId && params.update.sessionUpdate === 'tool_call_update' && params.update.status === 'in_progress') queue.progress()
          for (const chunk of chunker.update(params.update)) queue.chunk(chunk)
        },
      }),
      acp.ndJsonStream(
        Writable.toWeb(child.process.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.process.stdout) as ReadableStream<Uint8Array>
      )
    )

    /** The CLI and everything it started are gone before the exit is told. */
    let ended: Promise<void> | undefined
    const finish = (event: Parameters<EventQueue["exit"]>[0] | null) =>
      (ended ??= close(event))
    const close = async (event: Parameters<EventQueue["exit"]>[0] | null) => {
      ending = true
      if (pending.length > 0)
        log.warn(
          { dropped: pending.length },
          "session ended with unsent messages"
        )
      await child.kill()
      for (const chunk of chunker.close()) queue.chunk(chunk)
      if (event) queue.exit(event)
    }

    let sessionId = resumeId ?? ""
    const prompt = async (message: string): Promise<void> => {
      prompting = true
      let response: acp.PromptResponse
      try {
        response = await conn.prompt({
          sessionId,
          prompt: [{ type: "text", text: message }],
        })
      } catch (error) {
        prompting = false
        if (ending) return
        return finish({
          outcome: "failed",
          error: `Cursor: ${errorMessage(error)}. ${child.stderrTail()}`.trim(),
        })
      } finally {
        prompting = false
      }
      for (const chunk of chunker.close()) queue.chunk(chunk)
      if (response.usage) {
        queue.chunk({
          type: "data-usage",
          data: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            costUsd: null,
            source: "cursor acp prompt usage",
          },
        })
      }
      if (ending) return
      const handoff = ctx.readHandoff(log)
      if (handoff) return finish(handoff)
      const next = pending.shift()
      if (next) return prompt(next)
      if (response.stopReason === "cancelled")
        return finish({ outcome: "cancelled" })
      if (response.stopReason === "refusal")
        return finish({ outcome: "failed", error: "Cursor refused the task" })
      return finish({ outcome: "succeeded" })
    }

    void child.exited.then(({ code, signal }) => {
      if (ending) return
      ending = true
      for (const chunk of chunker.close()) queue.chunk(chunk)
      const handoff = ctx.readHandoff(log)
      if (handoff) return queue.exit(handoff)
      queue.exit({
        outcome: "failed",
        error: `cursor agent exited (${signal ?? code}): ${child.stderrTail() || "no output"}`,
      })
    })

    const mcp = ctx.mcpServer()
    const mcpServers: acp.McpServer[] = [
      {
        name: MCP_SERVER_NAME,
        command: mcp.command,
        args: mcp.args,
        env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })),
      },
      ...(computerMcp ? [{ name: COMPUTER_MCP_SERVER_NAME, command: computerMcp.command,
        args: computerMcp.args, env: Object.entries(computerMcp.env).map(([name, value]) => ({ name, value })) }] : []),
    ]
    const ready = <T>(step: Promise<T>, label: string) =>
      untilReady(child, step, `cursor ${label}`)
    try {
      await ready(
        conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "mikka", version: DAEMON_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        "initialize"
      )
      const newSession = async () => {
        sessionId = (
          await ready(
            conn.newSession({ cwd: ctx.worktree, mcpServers }),
            "session/new"
          )
        ).sessionId
      }
      if (!resumeId) await newSession()
      else {
        // `session/load` replays the history as updates; it is already shown.
        replaying = true
        try {
          await ready(
            conn.loadSession({
              sessionId: resumeId,
              cwd: ctx.worktree,
              mcpServers,
            }),
            "session/load"
          )
        } catch (error) {
          if (mode !== "continue" || ending) throw error
          log.info(
            { err: error, session_id: resumeId },
            "could not continue the earlier cursor session; starting a new one"
          )
          mode = "new"
          firstMessage = options.prompt ?? firstMessage
          await newSession()
        } finally {
          replaying = false
        }
      }
    } catch (error) {
      await finish(null)
      throw new Error(
        `Could not start the Cursor agent: ${errorMessage(error)}. ${child.stderrTail()}`.trim(),
        { cause: error }
      )
    }
    log.info({ session_id: sessionId, mode }, "cursor session started")
    // ACP has no system prompt: the run rules lead the first message.
    void prompt(
      mode === "new" ? `${ctx.instructions()}\n\n${firstMessage}` : firstMessage
    )

    return {
      sessionId,
      events: () => queue.drain(),
      async send(message) {
        if (ending) throw new Error("The Cursor session already ended")
        if (prompting) pending.push(message)
        else void prompt(message)
      },
      async cancel() {
        if (!ending) await conn.cancel({ sessionId }).catch(() => undefined)
        await finish({ outcome: "cancelled" })
      },
      async detach() {
        await finish(null)
      },
    }
  }
}
