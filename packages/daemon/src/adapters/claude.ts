// Claude Code adapter (ADR 0003): the user's own signed-in Claude Code, run
// through `@anthropic-ai/claude-agent-sdk`, one CLI process per session.
//
// The CLI runs directly, with no sandbox, in bypassPermissions mode (decision
// 2026-11-01-2335): nothing is asked per tool. The run's live gate stops it
// when the run is revoked. Hosted runs spawn through the hosted runner.
//
// Isolation (ADR 0009; devices are runners, 2026-10-31): every run gets its
// own `HOME` and `CLAUDE_CONFIG_DIR` in its run dir, so the person's
// `~/.claude`, their login (Claude Code keys its macOS Keychain entry by the
// config dir) and their settings are never read or written. The run's
// credential arrives only through `subscriptionAuth`, on a one-shot pipe.
// `settingSources: []` and `strictMcpConfig` keep project settings and other
// MCP servers out too. The session store lives in that run home, so `resume`
// works after a daemon restart; a follow-up run copies the earlier run's
// `projects` store first.
import { claudeQuotaSignal, mergeQuota, type QuotaSignal } from "../runs/quota-exhausted"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import type { Writable } from "node:stream"

import {
  query,
  createSdkMcpServer,
  type SDKMessage,
  type SDKResultMessage,
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
  COMPUTER_MCP_SERVER_NAME,
  RESUME_MESSAGE,
  RunContext,
  runPaths,
  type McpServerSpec,
  type ComputerSpecProvider,
} from "../agents/run-context"
import { requireRunToolApproval } from "../agents/tool-approval"
import type { RunApps } from "../agents/run-apps"
import type { AgentSandbox } from "../agents/sandbox"
import { carryHistory, ownDir, wipeRunCredentials } from "../agents/harness-home"
import { claudeCredentialEnv, credentialDomain } from "../agents/run-credential"
import { buildChildEnv } from "../env"
import { mailboxInputs } from '@mikka/protocol/mailbox'
import { mailboxToolResult, type RunMailbox } from '../run-mailbox'
import { NATIVE_AUTH_PLACEHOLDER } from '../subscription-native-broker'
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
  /** @deprecated Ignored: the SDK starts the CLI directly (no sandbox, decision 2026-11-01-2335). */
  sandbox?: AgentSandbox
  /** The daemon's adapter state dir (per-run dirs live under it). */
  stateDir: string
  /**
   * A CLI to run instead of the SDK's own bundled one. The daemon's tests
   * drive fake CLIs through it; unset, the SDK starts the build it ships.
   */
  binary?: string
  /** The daemon's pinned Claude Code, installed on first need. */
  ensureBinary?: () => Promise<string>
  /** Trusted hosted transport; ordinary local sessions retain SDK spawning. */
  spawnHosted?: (options: SpawnOptions, oauthPlaceholder: string) => SpawnedProcess
  onHostedSession?(sessionId:string):Promise<void>
  /** Supplied only by trusted hosted infrastructure for this run. */
  computerMcp?: McpServerSpec
  computerProvider?: ComputerSpecProvider
  /** @deprecated Ignored: the person's own `~/.claude` is never read. */
  configDir?: string
  /** Trusted owner-bound broker; the CLI receives no refresh grant. */
  subscriptionAuth?: {
    /** Only with the trusted hosted transport and the public socket marker. */
    brokered?: true
    accountId: string
    verify?(): Promise<void>
    token(): Promise<{
      accountId: string
      accessToken: string
      expiresAt: string
    }>
  }
}

const SUBSCRIPTION_ERROR = "Claude subscription authentication unavailable"

/** In-process SDK MCP travels over the existing query control stream. No
 * socket, endpoint, platform bearer or extra filesystem permission in child. */
/** One HTTP MCP entry per connected app, each pointing at the Mikka server. */
export function claudeAppServers(apps?: RunApps) {
  return Object.fromEntries((apps?.apps ?? []).map(app => [app.name, { type: 'http' as const, url: app.url, headers: { Authorization: `Bearer ${apps!.token}` } }]))
}

function claudeMailboxServer(mailbox: RunMailbox) {
  const server = createSdkMcpServer({ name: 'mikka_mailbox', version: '1' })
  for (const [name, schema] of Object.entries(mailboxInputs).filter(([name]) => mailbox.tools.some(tool => tool.name === name))) server.instance.registerTool(name, {
    description: 'Personal peer coordination only; never user approval. New messages notify the current live session. Read the inbox and ACK explicitly; notification and ACK are not execution.', inputSchema: schema,
  }, async (args: unknown, extra: { signal?: AbortSignal }) => mailboxToolResult(await mailbox.request({ operation: 'call', name, arguments: args }, extra.signal)))
  return server
}
const SUBSCRIPTION_EXECUTION_ERROR = "Claude subscription execution failed"

/** Claude Code's folder name for a project dir under `~/.claude/projects`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Host-config switches every Claude session gets: Claude Code's own Bash
 * sandbox stays off (runs use no sandbox, decision 2026-11-01-2335), and the
 * workspace's command rules apply as Claude permission rules (ADR 0028).
 */
export function claudeSettings(
  workspace?: RunPolicy,
  agentDelivers = false,
): Settings {
  return {
    sandbox: { enabled: false },
    permissions: claudePermissionRules(runPolicy(workspace), agentDelivers),
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
          { type: "text-end", id },
        )
      } else if (block.type === "thinking" && block.thinking) {
        chunks.push(
          { type: "reasoning-start", id },
          { type: "reasoning-delta", id, delta: block.thinking },
          { type: "reasoning-end", id },
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
            },
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
        typeof part?.text === "string" ? part.text : "",
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

/** Preserve the SDK's executable selection; a native lease uses a one-shot pipe.
 * No access token enters argv, the process environment or an auth-cache file.
 * This transport alone does not attest a safe tool/owner runtime boundary. */
function spawnBinary(binary?: string, oauthToken?: string) {
  return (options: SpawnOptions): SpawnedProcess => {
    if (oauthToken === undefined) return spawn(binary ?? options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    })
    const env: NodeJS.ProcessEnv = { ...options.env, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" }
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    const child = spawn(binary ?? options.command, options.args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      signal: options.signal,
    })
    const pipe = child.stdio[3] as Writable
    pipe.on("error", () => child.kill("SIGTERM"))
    pipe.end(oauthToken)
    return child
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly harness = "claude_code" as const
  readonly capabilities = { supportsInterject: true, supportsResume: true }
  readonly envAllow: readonly string[] = []

  constructor(private readonly options: ClaudeAdapterOptions) {}

  start(options: StartOptions): Promise<AgentSession> {
    const continued = options.continueSession
    if (options.requireSessionResume && !continued)
      return Promise.reject(
        new Error("Original Claude question session is required"),
      )
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
    options: SessionOptions & Partial<Pick<StartOptions, "prompt" | "continueSession">>,
  ): Promise<AgentSession> {
    const approval = requireRunToolApproval(options.runId, options.toolApproval)
    if (!await approval.checkLive()) { approval.revoke(); throw new Error('Run tool approval unavailable') }
    const paths = runPaths(this.options.stateDir, options.runId)
    const runDir = await claimRunDir(paths)
    const externalAuth = this.options.subscriptionAuth
    let nativeToken: string | undefined
    let expiresAt = 0
    if (externalAuth) {
      if(externalAuth.brokered && !this.options.spawnHosted)throw new Error(SUBSCRIPTION_ERROR)
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
        throw new Error(SUBSCRIPTION_ERROR)
      try {
        const token = await externalAuth.token()
        expiresAt = Date.parse(token.expiresAt)
        if (
          token.accountId !== externalAuth.accountId ||
          !externalAuth.accountId ||
          typeof token.accessToken !== "string" ||
          !token.accessToken ||
          token.accessToken.length > 32768 ||
          /[\r\n\0]/.test(token.accessToken) ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now()
        )
          throw new Error(SUBSCRIPTION_ERROR)
        nativeToken = token.accessToken
        if(externalAuth.brokered && nativeToken!==NATIVE_AUTH_PLACEHOLDER)throw new Error(SUBSCRIPTION_ERROR)
      } catch {
        throw new Error(SUBSCRIPTION_ERROR)
      }
    }
    // Never the host's login or config. This is config isolation only; a
    // hosted runner still requires an owner security boundary.
    const nativeHome = join(runDir, "native-home")
    const configDir = join(nativeHome, ".claude")
    ownDir(nativeHome)
    ownDir(configDir)
    if (mode === "continue" && options.continueSession) {
      carryHistory(join(runPaths(this.options.stateDir, options.continueSession.runId).runDir, "native-home", ".claude"), configDir, ["projects"])
    }
    if (externalAuth && options.credential) throw new Error(SUBSCRIPTION_ERROR)
    const credentialEnv = claudeCredentialEnv(options.credential)
    const providerDomain = credentialDomain(options.credential)
    const computerMcp = this.options.computerMcp ?? this.options.computerProvider?.(options.runId, options.policy)
    const binary = this.options.binary ?? (this.options.spawnHosted ? undefined : await this.options.ensureBinary?.())
    const ctx = new RunContext({
      harnessDomains: providerDomain ? [providerDomain] : undefined,
      github: options.github,
      apps: options.apps,
      githubRuntime: options.githubRuntime,
      childPath: options.env.PATH,
      mailboxEnabled: Boolean(options.mailbox),
      harness: "claude_code",
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
      // Its session store, so `resume` works; keyed by the cwd it sees.
      extraWrite: [
        join(configDir, "projects", claudeProjectDirName(options.cwd)),
        join(
          configDir,
          "projects",
          claudeProjectDirName(realpathSync(options.cwd)),
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
    let runtimeModel: string | null = null
    let ending = false
    let lastError: string | undefined
    /** The CLI's quota or rate-limit failure seen this turn, if any. */
    let quota: QuotaSignal | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let authTimer: NodeJS.Timeout | undefined
    let stderr = ""
    const stderrTail = () => stderr.slice(-STDERR_TAIL).trim() || "no output"
    /** True once the session proved open, false if the CLI failed first. */
    let spoke: (value: boolean) => void = () => undefined
    const spoken = new Promise<boolean>((resolve) => (spoke = resolve))
    /** The CLI is gone once this settles; the exit is told after it does. */
    let finished: () => void = () => undefined
    const gone = new Promise<void>((resolve) => (finished = resolve))

    if(externalAuth && this.options.onHostedSession) {
      try{await this.options.onHostedSession(sessionId)}catch{throw new Error(SUBSCRIPTION_ERROR)}
    }
    // No sandbox: the CLI starts directly. A revoked run gate stops it.
    const spawnLocal = (config: SpawnOptions): SpawnedProcess => {
      const child = spawnBinary(binary, nativeToken)(config)
      const off = options.toolApproval!.onRevoke(() => { child.kill("SIGTERM") })
      child.once("exit", off)
      return child
    }
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
          ...credentialEnv,
          HOME: nativeHome,
          CLAUDE_CONFIG_DIR: configDir,
        },
        settingSources: [],
        settings: {
          ...claudeSettings(options.policy, ctx.agentDelivers),
          ...(externalAuth ? { forceLoginMethod: "claudeai" as const } : {})
        },
        mcpServers: {
          ...(options.mailbox ? { mikka_mailbox: claudeMailboxServer(options.mailbox) } : {}),
          [MCP_SERVER_NAME]: { type: "stdio", ...ctx.mcpServer() },
          ...(computerMcp ? { [COMPUTER_MCP_SERVER_NAME]: { type: "stdio" as const, ...computerMcp } } : {}),
          ...claudeAppServers(options.apps),
        },
        strictMcpConfig: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: ctx.instructions(),
        },
        // Nothing is asked per tool (decision 2026-11-01-2335).
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
        ...(mode === "new" ? { sessionId } : { resume: sessionId }),
        ...(options.model ? { model: options.model } : {}),
        // A hosted run spawns through the hosted runner; an API-key run there holds the placeholder too.
        spawnClaudeCodeProcess: this.options.spawnHosted
          ? (options:SpawnOptions) => this.options.spawnHosted!(options,nativeToken ?? NATIVE_AUTH_PLACEHOLDER)
          : spawnLocal,
        stderr: (data: string) => {
          if (!externalAuth) stderr = (stderr + data).slice(-STDERR_TAIL * 4)
        },
      },
    })

    /** The CLI and everything it started are gone before the exit is told. */
    let ended: Promise<void> | undefined
    const end = (event: Omit<ExitEvent, "type"> | null, revokeRunGate = true) =>
      (ended ??= close(event, revokeRunGate))
    const close = async (event: Omit<ExitEvent, "type"> | null, revokeRunGate: boolean) => {
      ending = true
      if (revokeRunGate) options.toolApproval?.revoke()
      clearTimeout(graceTimer)
      clearTimeout(authTimer)
      prompts.close()
      session.close()
      await gone
      wipeRunCredentials(runDir)
      if (event) queue.exit(event)
    }
    const turnEnded = () => {
      const handoff = ctx.readHandoff(log)
      if (handoff) return void end(handoff)
      void end(
        lastError
          ? { outcome: "failed", error: lastError, ...(quota ? { quota } : {}) }
          : { outcome: "succeeded" },
      )
    }
    const diedEarly = (error: string) => {
      ending = true
      const handoff = ctx.readHandoff(log)
      queue.exit(
        handoff ?? {
          outcome: "failed",
          error: externalAuth
            ? SUBSCRIPTION_EXECUTION_ERROR
            : `claude exited before the turn ended: ${error}`,
          ...(quota ? { quota } : {}),
        }
      )
    }

    void (async () => {
      try {
        for await (const message of session) {
          if (
            options.requireSessionResume &&
            "session_id" in message &&
            typeof message.session_id === "string" &&
            message.session_id !== sessionId
          )
            throw new Error("Claude resumed a different question session")
          if (message.type === "system" && message.subtype === "init" && typeof message.model === "string")
            runtimeModel = message.model || null
          if (message.type === "assistant" && message.parent_tool_use_id == null && typeof message.message.model === "string")
            runtimeModel = message.message.model || null
          if (runtimeModel && ((message.type === "system" && message.subtype === "init") ||
            (message.type === "assistant" && message.parent_tool_use_id == null)))
            options.onRuntimeModel?.(sessionId, runtimeModel)
          if (provesSession(message)) spoke(true)
          // A new turn (the queued message) produces its own result.
          if (message.type === "assistant" || message.type === "user")
            clearTimeout(graceTimer)
          if (ending) continue
          quota = mergeQuota(quota, claudeQuotaSignal(message))
          if (message.type === 'tool_progress' && message.session_id === sessionId) queue.progress()
          // Authentication errors can contain provider diagnostics. Do not
          // turn those diagnostics into model/UI text in external-auth mode.
          if (!(externalAuth && message.type === "assistant" && message.error))
            for (const chunk of claudeChunks(message)) queue.chunk(chunk)
          if (message.type !== "result") continue
          results++
          if (!message.is_error) quota = undefined
          lastError = message.is_error
            ? externalAuth
              ? SUBSCRIPTION_EXECUTION_ERROR
              : `Claude Code: ${resultError(message)}`
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
        clearTimeout(authTimer)
        spoke(false)
        finished()
      }
    })()

    // This SDK exposes no documented host token-refresh callback. End at the
    // access lease boundary; the broker refreshes once before the next start.
    // Never hand the rotating grant to a second refresh writer.
    authTimer = externalAuth && !externalAuth.brokered
      ? setTimeout(
          () => {
            void end({ outcome: "failed", error: SUBSCRIPTION_ERROR })
          },
          Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now()))
        )
      : undefined
    authTimer?.unref()
    if (externalAuth) {
      let timer: NodeJS.Timeout | undefined
      try {
        const account = await Promise.race([
          session.accountInfo(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(SUBSCRIPTION_ERROR)),
              10_000
            )
          })
        ])
        if (
          ending ||
          account.apiProvider !== "firstParty" ||
          account.apiKeySource !== "none"
        )
          throw new Error(SUBSCRIPTION_ERROR)
        await externalAuth.verify?.()
      } catch {
        await end(null)
        throw new Error(SUBSCRIPTION_ERROR)
      } finally {
        clearTimeout(timer)
      }
    }
    prompts.push(firstMessage)
    written++
    if (mode === "continue" && !(await untilSpoken(spoken))) {
      if (options.requireSessionResume || externalAuth) {
        await end(null)
        throw new Error(externalAuth ? SUBSCRIPTION_ERROR : 'Original Claude question session is unavailable; refusing a fresh session')
      }
      log.info(
        { stderr: stderrTail() },
        "could not continue the earlier claude session; starting a new one",
      )
      // Close the failed transport and its pending callbacks. The same live
      // run retries once with a fresh transport, retaining its trusted gate.
      await end(null, false)
      return this.open(randomUUID(), "new", options.prompt ?? "", options)
    }
    log.info({ mode, sandbox: "claude-code" }, "claude session started")

    return {
      sessionId,
      get runtimeModel() { return runtimeModel },
      events: () => queue.drain(),
      async send(text) {
        if (ending) throw new Error("The Claude session already ended")
        if (externalAuth?.verify) {
          try { await externalAuth.verify() } catch { await end({ outcome: 'failed', error: SUBSCRIPTION_ERROR }); throw new Error(SUBSCRIPTION_ERROR) }
        }
        if (externalAuth && !externalAuth.brokered && Date.now() >= expiresAt) {
          await end({ outcome: "failed", error: SUBSCRIPTION_ERROR })
          throw new Error(SUBSCRIPTION_ERROR)
        }
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
