// Claude Code adapter (ADR 0003): the user's own signed-in Claude Code, run
// through `@anthropic-ai/claude-agent-sdk`, one CLI process per session.
//
// The SDK starts the CLI itself — its own bundled build, not one from PATH —
// so this adapter no longer hands a child to the daemon's `AgentSandbox`.
// Instead the run's policy goes to Claude Code's own sandbox through the
// `settings` option (the JSON `--settings` took before): the agent's commands
// may write only where the run allows (the worktree, the run dir, the
// harness's own state), may read everything but the credential stores, and
// may reach only the run's domains. `allowUnsandboxedCommands: false` keeps
// the agent from stepping outside it, and `failIfUnavailable` makes a sandbox
// that cannot start an error rather than a silent fallback to no sandbox.
//
// What this does not cover: the sandbox confines the commands the agent runs,
// not the CLI's own tools. Read/Write/Edit and WebFetch/WebSearch run inside
// the CLI process, so neither the filesystem lists nor the network list bound
// them the way the daemon's outer sandbox bounded everything the CLI did
// (measured, not assumed). Permission deny rules do still bite in bypass mode
// — `Read(<path>)`, `Edit(<path>)`, or a bare tool name — so the credential
// stores can be closed again by generating rules from `policy.denyRead`.
//
// Isolation (ADR 0009) without touching the login: Claude Code keeps its
// OAuth token in the macOS Keychain under a name derived from its config
// dir, so a separate `CLAUDE_CONFIG_DIR` would mean copying the token.
// Instead the CLI keeps `~/.claude` and is told to ignore the host's config:
// `settingSources: []` loads no user, project or local settings (hooks,
// plugins, permissions, CLAUDE.md), and `strictMcpConfig` with only Mikka's
// server drops every host MCP server. The only writable path outside the
// worktree is this worktree's session store under `~/.claude/projects`, so
// `resume` works after a daemon restart and for a follow-up run in the same
// worktree (the store is keyed by the cwd).
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type PermissionMode,
  type SDKUserMessage,
  type Settings,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk"

import {
  claimRunDir,
  endedSession,
  errorMessage,
  EventQueue,
} from "../agents/child"
import {
  MCP_SERVER_NAME,
  RESUME_MESSAGE,
  RunContext,
  runPaths,
} from "../agents/run-context"
import type { SandboxPolicy } from "../agents/sandbox"
import type { RunChunk } from "../chunks"
import {
  claudePermissionRules,
  runPolicy,
  type RunPolicy,
} from "../permissions"
import type {
  AgentAdapter,
  AgentSession,
  ExitEvent,
  SessionOptions,
  StartOptions,
} from "./types"

export interface ClaudeAdapterOptions {
  /** The daemon's adapter state dir (per-run dirs live under it). */
  stateDir: string
  /**
   * A CLI to run instead of the SDK's own bundled one. The daemon's tests
   * drive fake CLIs through it; unset, the SDK starts the build it ships.
   */
  binary?: string
  /** `~/.claude` of the user whose login the CLI uses. */
  configDir?: string
}

/** Claude Code's folder name for a project dir under `~/.claude/projects`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * The run's policy as Claude Code's own sandbox (ADR 0009). The CLI process
 * itself is not confined — it is the SDK's child, and it needs its login and
 * the model API — but every command the agent runs through it is.
 *
 * `network` is left out when the run may reach any host: the sandbox refuses
 * a bare `*` allow-list entry, and a host no list covers is prompted for,
 * which bypass mode auto-allows.
 */
export function claudeSandboxSettings(
  policy: SandboxPolicy
): NonNullable<Settings["sandbox"]> {
  const anyHost = policy.allowDomains.includes("*")
  return {
    enabled: true,
    // Nobody is watching: a sandbox that cannot start must not be skipped.
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    // Rust and Go CLIs verify TLS through trustd, which the sandbox
    // otherwise blocks; the daemon's own sandbox sets this for the same
    // reason. Network egress is still confined to the domains below.
    enableWeakerNetworkIsolation: true,
    filesystem: {
      allowWrite: [...policy.allowWrite],
      denyWrite: [...(policy.denyWrite ?? [])],
      denyRead: [...(policy.denyRead ?? [])],
    },
    ...(anyHost
      ? {}
      : {
          network: {
            allowedDomains: [...policy.allowDomains],
            // Deny what no list covers rather than asking a person who is
            // not there (the daemon's own sandbox does the same).
            strictAllowlist: true,
          },
        }),
  }
}

/**
 * Host-config switches every Claude session gets (see the header), with the
 * workspace's command rules as Claude permission rules (ADR 0028).
 */
export function claudeSettings(
  policy: SandboxPolicy,
  workspace?: RunPolicy
): Settings {
  return {
    sandbox: claudeSandboxSettings(policy),
    permissions: claudePermissionRules(runPolicy(workspace)),
  }
}

/** Claude Code SDK messages as UI message chunks. */
export function claudeChunks(message: SDKMessage): RunChunk[] {
  const chunks: RunChunk[] = []
  if (message.type === "assistant") {
    message.message.content.forEach((block, index) => {
      const id = `${message.message.id ?? randomUUID()}-${index}`
      if (block.type === "text" && block.text) {
        chunks.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: block.text },
          { type: "text-end", id }
        )
      } else if (block.type === "thinking" && block.thinking) {
        chunks.push(
          { type: "reasoning-start", id },
          { type: "reasoning-delta", id, delta: block.thinking },
          { type: "reasoning-end", id }
        )
      } else if (block.type === "tool_use") {
        chunks.push({
          type: "tool-input-available",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        })
      }
    })
  } else if (message.type === "user") {
    const content = message.message.content
    if (!Array.isArray(content)) return chunks
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const output = toolResultText(block.content)
      chunks.push(
        block.is_error
          ? {
              type: "tool-output-error",
              toolCallId: block.tool_use_id,
              errorText: output,
            }
          : {
              type: "tool-output-available",
              toolCallId: block.tool_use_id,
              output,
            }
      )
    }
  } else if (message.type === "result") {
    chunks.push({
      type: "data-usage",
      data: {
        inputTokens: message.usage.input_tokens ?? 0,
        outputTokens: message.usage.output_tokens ?? 0,
        costUsd: message.total_cost_usd ?? null,
        source: "claude agent sdk result",
      },
    })
  }
  return chunks
}

/** Why a turn's result is an error, as the old adapter read it off the CLI. */
function resultError(message: SDKResultMessage): string {
  const text =
    message.subtype === "success"
      ? message.result
      : message.errors.join("; ") || message.subtype
  return text || message.subtype
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.slice(-4000)
  if (Array.isArray(content)) {
    return content
      .map((part: { text?: unknown }) =>
        typeof part?.text === "string" ? part.text : ""
      )
      .join("\n")
      .slice(-4000)
  }
  return ""
}

/**
 * Unattended: no background shells or scheduled wake-ups that would
 * outlive the turn, no auto-memory written for later sessions.
 */
const CLAUDE_RUN_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
}

/** After a result, how long to wait for queued messages to start a turn. */
const QUEUED_TURN_GRACE_MS = 30_000

/** How long a continued session may stay silent before it counts as open. */
const CONTINUE_SILENCE_MS = 60_000

/** Last part of stderr kept for error messages. */
const STDERR_TAIL = 4000

/**
 * The prompt the SDK reads: a push queue, so `send` can hand the agent a
 * message while a turn is running and `close` can end its input.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: (() => void) | null = null
  private closed = false

  constructor(private readonly sessionId: string) {}

  push(text: string) {
    if (this.closed) throw new Error("The Claude session already ended")
    this.items.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
    this.wake()
  }

  close() {
    this.closed = true
    this.wake()
  }

  private wake() {
    this.waiter?.()
    this.waiter = null
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }
}

/**
 * Whether a message proves the session opened. A session the CLI does not
 * have fails before it says anything: it reports the error and exits.
 */
function provesSession(message: SDKMessage): boolean {
  if (message.type === "assistant" || message.type === "user") return true
  return message.type === "system" && message.subtype === "init"
}

/**
 * Whether the CLI spoke before it exited; a CLI that says nothing for
 * `CONTINUE_SILENCE_MS` is taken as open (the watchdog handles a wedge).
 */
async function untilSpoken(spoken: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      spoken,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), CONTINUE_SILENCE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs `binary` where the SDK would have started its own bundled CLI. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

function isClaudeEffort(
  effort: string | undefined
): effort is (typeof CLAUDE_EFFORTS)[number] {
  return (CLAUDE_EFFORTS as readonly (string | undefined)[]).includes(effort)
}

function spawnBinary(binary: string) {
  return (options: SpawnOptions): SpawnedProcess =>
    spawn(binary, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    })
}

export class ClaudeAdapter implements AgentAdapter {
  readonly harness = "claude_code" as const
  readonly capabilities = { supportsInterject: true, supportsResume: true }
  readonly envAllow: readonly string[] = []

  constructor(private readonly options: ClaudeAdapterOptions) {}

  start(options: StartOptions): Promise<AgentSession> {
    const continued = options.continueSession
    return continued
      ? this.open(continued.sessionId, "continue", continued.message, options)
      : this.open(randomUUID(), "new", options.prompt, options)
  }

  resume(sessionId: string, options: SessionOptions): Promise<AgentSession> {
    return this.open(sessionId, "restart", RESUME_MESSAGE, options)
  }

  /**
   * `restart`: this run's own session after a daemon restart. `continue`:
   * an earlier run's session, for a follow-up run; when the session cannot
   * be reopened (the CLI has no such session), a new session gets the full
   * brief instead.
   */
  private async open(
    sessionId: string,
    mode: "new" | "restart" | "continue",
    firstMessage: string,
    options: SessionOptions & { prompt?: string }
  ): Promise<AgentSession> {
    const configDir = this.options.configDir ?? join(homedir(), ".claude")
    const paths = runPaths(this.options.stateDir, options.runId)
    const ctx = new RunContext({
      harness: "claude_code",
      kind: options.kind,
      worktree: options.cwd,
      networkAllow: options.networkAllow,
      policy: options.policy,
      skills: options.skills,
      runDir: await claimRunDir(paths),
      privateDir: paths.privateDir,
      // Its session store, so `resume` works; keyed by the cwd it sees.
      extraWrite: [
        join(configDir, "projects", claudeProjectDirName(options.cwd)),
        join(
          configDir,
          "projects",
          claudeProjectDirName(realpathSync(options.cwd))
        ),
      ],
    })
    const log = options.log.child({
      harness: "claude_code",
      session_id: sessionId,
    })
    // A hand-in the last daemon never got to act on ends the session now.
    // The run dir is this run's own: a follow-up never sees the earlier
    // run's hand-in.
    const earlier = mode === "restart" ? ctx.readHandoff(log) : null
    if (earlier) return endedSession(sessionId, earlier)
    ctx.clearHandoff()

    const queue = new EventQueue()
    const prompts = new PromptQueue(sessionId)
    let written = 0
    let results = 0
    let ending = false
    let lastError: string | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let stderr = ""
    const stderrTail = () => stderr.slice(-STDERR_TAIL).trim() || "no output"
    /** True once the session proved open, false if the CLI failed first. */
    let spoke: (value: boolean) => void = () => undefined
    const spoken = new Promise<boolean>((resolve) => (spoke = resolve))
    /** The CLI is gone once this settles; the exit is told after it does. */
    let finished: () => void = () => undefined
    const gone = new Promise<void>((resolve) => (finished = resolve))

    const session = query({
      prompt: prompts,
      options: {
        cwd: ctx.worktree,
        // Replaces the environment: the CLI sees the run's clean env only.
        env: {
          ...options.env,
          ...ctx.tempEnv(),
          ...CLAUDE_RUN_ENV,
          CLAUDE_CODE_TMPDIR: ctx.tmpDir,
        },
        settingSources: [],
        settings: claudeSettings(ctx.policy(), options.policy),
        mcpServers: {
          [MCP_SERVER_NAME]: { type: "stdio", ...ctx.mcpServer() },
        },
        strictMcpConfig: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: ctx.instructions(),
        },
        // Mikka's default is bypass inside the sandbox. A mode that asks has
        // no one to answer yet (approval cards are not built), so Claude
        // Code denies what it would have asked about.
        permissionMode: (options.permissionMode ??
          "bypassPermissions") as PermissionMode,
        ...((options.permissionMode ?? "bypassPermissions") ===
        "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(mode === "new" ? { sessionId } : { resume: sessionId }),
        ...(options.model ? { model: options.model } : {}),
        ...(isClaudeEffort(options.effort) ? { effort: options.effort } : {}),
        ...(this.options.binary
          ? { spawnClaudeCodeProcess: spawnBinary(this.options.binary) }
          : {}),
        stderr: (data: string) => {
          stderr = (stderr + data).slice(-STDERR_TAIL * 4)
        },
      },
    })

    /** The CLI and everything it started are gone before the exit is told. */
    let ended: Promise<void> | undefined
    const end = (event: Omit<ExitEvent, "type"> | null) =>
      (ended ??= close(event))
    const close = async (event: Omit<ExitEvent, "type"> | null) => {
      ending = true
      clearTimeout(graceTimer)
      prompts.close()
      session.close()
      await gone
      if (event) queue.exit(event)
    }
    const turnEnded = () => {
      const handoff = ctx.readHandoff(log)
      if (handoff) return void end(handoff)
      void end(
        lastError
          ? { outcome: "failed", error: lastError }
          : { outcome: "succeeded" }
      )
    }
    const diedEarly = (error: string) => {
      ending = true
      const handoff = ctx.readHandoff(log)
      queue.exit(
        handoff ?? {
          outcome: "failed",
          error: `claude exited before the turn ended: ${error}`,
        }
      )
    }

    void (async () => {
      try {
        for await (const message of session) {
          if (provesSession(message)) spoke(true)
          // A new turn (the queued message) produces its own result.
          if (message.type === "assistant" || message.type === "user")
            clearTimeout(graceTimer)
          if (ending) continue
          for (const chunk of claudeChunks(message)) queue.chunk(chunk)
          if (message.type !== "result") continue
          results++
          lastError = message.is_error
            ? `Claude Code: ${resultError(message)}`
            : undefined
          if (results >= written) {
            turnEnded()
            continue
          }
          // A message sent mid-turn may still start a turn of its own, or
          // the CLI may have folded it into this one: wait a little, then
          // end. A hand-in already on disk does not end it sooner: this
          // result can be read after the next turn called submit, and that
          // turn's last words and result are still on their way.
          graceTimer = setTimeout(turnEnded, QUEUED_TURN_GRACE_MS)
        }
        if (!ending) diedEarly(stderrTail())
      } catch (error) {
        if (!ending) diedEarly(errorMessage(error))
      } finally {
        spoke(false)
        finished()
      }
    })()

    prompts.push(firstMessage)
    written++
    if (mode === "continue" && !(await untilSpoken(spoken))) {
      log.info(
        { stderr: stderrTail() },
        "could not continue the earlier claude session; starting a new one"
      )
      await end(null)
      return this.open(randomUUID(), "new", options.prompt ?? "", options)
    }
    log.info({ mode, sandbox: "claude-code" }, "claude session started")

    return {
      sessionId,
      events: () => queue.drain(),
      async send(text) {
        if (ending) throw new Error("The Claude session already ended")
        written++
        prompts.push(text)
      },
      async cancel() {
        await end({ outcome: "cancelled" })
      },
      async detach() {
        await end(null)
      },
    }
  }
}
