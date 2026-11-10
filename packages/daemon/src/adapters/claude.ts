import type { AnonymousClaudeCandidate, FreshCandidate } from '../anonymous-claude-spare'
import { captureRunFailure, failureFrom, type RunFailure, type RunFailureContext } from "@mikka/protocol/run-failure"
import { DAEMON_VERSION } from "../paths"
// Claude Code adapter (ADR 0003): the user's own signed-in Claude Code, run
// through `@anthropic-ai/claude-agent-sdk`, one CLI process per session.
//
// The CLI runs directly, with no sandbox, in bypassPermissions mode (decision
// 2026-11-01-2335): nothing is asked per tool. The run's live gate stops it
// when the run is revoked. Hosted runs spawn through the hosted runner.
//
// Personal runs retain their existing session storage: every run gets its
// own `HOME` and `CLAUDE_CONFIG_DIR` in its run dir, so the person's
// `~/.claude`, their login (Claude Code keys its macOS Keychain entry by the
// config dir) and their settings are never read or written. The run's
// credential arrives only through `subscriptionAuth`, on a one-shot pipe.
// `settingSources: []` and `strictMcpConfig` keep project settings and other
// MCP servers out too. The session store lives in that run home, so `resume`
// works after a daemon restart; a follow-up run copies the earlier run's
// `projects` store first.
// Cloud tasks own the VM and use its normal HOME/settings with direct native
// credentials (decision 2026-11-06-1800); no extra inner environment is made.
import { claudeQuotaSignal, mergeQuota, type QuotaSignal } from "../runs/quota-exhausted"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { daemonTracer, runIdHash } from "../tracing"
import { ClaudeGenerationMetrics } from './generation-metrics'
import { prepareClaudeSession, ClaudeProjectSettingsNotClaimable, type ClaudePrewarmBinding, type ClaudePreparation } from './claude-prewarm'
import { runRuntimeTimings } from '../run-runtime-timing'
import type { Readable, Writable } from "node:stream"

import {
  query,
  prewarm,
  createSdkMcpServer,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Settings,
  type Options,
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
  prepareRunContextFiles,
  runMcpBackendContext,
  type RunContextOptions,
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
import { taskExecutionEnv } from '../task-env'
import { mailboxInputs } from '@mikka/protocol/mailbox'
import { classifyProviderFailure, ProviderFailureError, providerFailureMessage, type ProviderFailure } from "@mikka/protocol/provider-failure"
import { mailboxToolResult, type RunMailbox } from '../run-mailbox'
import { NATIVE_AUTH_PLACEHOLDER } from '../subscription-native-broker'
import type { RunChunk } from "../chunks"
import { CLI_EXITED_EARLY, redactDiagnostic, resultDiagnostics, subscriptionFailureCategory } from "./claude-failure"
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
  spawnHosted?: (options: SpawnOptions, oauthToken?: string) => SpawnedProcess & { stderr?: Readable }
  onHostedSession?(sessionId:string):Promise<void>
  anonymousClaudeCandidate?: AnonymousClaudeCandidate
  anonymousClaudeFresh?: FreshCandidate
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
    /** A background lease cache supplies native SDK refresh requests locally. */
    automaticRefresh?: true
    verify?(): Promise<void>
    token(): Promise<{
      accountId: string
      accessToken: string
      expiresAt: string
    }>
  }
}

const SUBSCRIPTION_ERROR = "Claude subscription authentication unavailable"
const INITIALIZATION_TIMEOUT_MS = 30_000

/** CLI initialization includes local cold startup; it is not a credential check. */
export class ClaudeInitializationError extends Error {
  readonly code: "claude_code_initialization_timeout" | "claude_code_initialization_failed"
  constructor(timeout: boolean) {
    super(timeout ? "Claude Code initialization timed out" : "Claude Code initialization failed")
    this.name = "ClaudeInitializationError"
    this.code = timeout ? "claude_code_initialization_timeout" : "claude_code_initialization_failed"
  }
}

/** In-process SDK MCP travels over the existing query control stream. No
 * socket, endpoint, platform bearer or extra filesystem permission in child. */
/** One HTTP MCP entry per connected app, each pointing at the Mikka server. */
export function claudeAppServers(apps?: RunApps) {
  return Object.fromEntries((apps?.apps ?? []).map(app => [app.name, { type: 'http' as const, url: app.url, headers: { Authorization: `Bearer ${apps!.token}` } }]))
}

export function claudeMailboxServer(mailbox: RunMailbox) {
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
export function claudeSettings(workspace?: RunPolicy): Settings {
  return {
    sandbox: { enabled: false },
    permissions: claudePermissionRules(runPolicy(workspace)),
    // Keep the issue marker last in PR bodies without changing commit attribution.
    attribution: { pr: "" },
  }
}

/** Built-in tools that only read; they never reach the approval gate. */
const PLANNING_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite"])
/** The host hand-in tools enforce the policy themselves; an app entry follows
 * the same server-side app rules. Computer use has its own broker ask. */
const isHostTool = (name: string) => name.startsWith("mcp__mikka__")
const isComputerTool = (name: string) => name.startsWith("mcp__mikka_computer__")
const isAppTool = (name: string) => name.startsWith("mcp__") && !name.startsWith("mcp__mikka")

/** A local view of the SDK's canUseTool context; the SDK passes these fields. */
type CanUseToolContext = { signal?: AbortSignal; toolUseID?: string; requestId?: string }

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

/** Only the CLI's terminal API result is provider evidence, never tool/model text. */
export function claudeProviderFailure(result: SDKResultMessage, assistantError: unknown): ProviderFailure | undefined {
  if (!result.is_error || !["success", "error_during_execution"].includes(result.subtype)) return undefined
  const fields = result as unknown as Record<string, unknown>
  if (typeof fields.terminal_reason === "string" && [
    "prompt_too_long", "image_error", "model_error", "malformed_tool_use_exhausted",
    "aborted_tools", "stop_hook_prevented", "hook_stopped", "max_turns", "budget_exhausted",
    "structured_output_retry_exhausted", "tool_deferred_unavailable",
  ].includes(fields.terminal_reason)) return undefined
  const diagnostic = result.subtype === "success" ? result.result : result.errors.join("\n")
  const apiDiagnostic = typeof diagnostic === "string" && /^API Error:\s*/i.test(diagnostic)
  // Older CLI API results have only the fixed prefix. This is already a
  // terminal is_error result; ordinary assistant/tool messages never enter.
  const providerResult = fields.api_error_status != null || typeof assistantError === "string" ||
    fields.terminal_reason === "api_error" || apiDiagnostic
  if (!providerResult) return undefined
  const prefixStatus = apiDiagnostic ? /^API Error:\s*([1-5]\d{2})\b/i.exec(diagnostic)?.[1] : undefined
  const bodyStart = apiDiagnostic ? diagnostic.indexOf("{") : -1
  const bodyEnd = apiDiagnostic ? diagnostic.lastIndexOf("}") : -1
  const failure = classifyProviderFailure({
    status: fields.api_error_status ?? (prefixStatus ? Number(prefixStatus) : undefined),
    code: assistantError,
    ...(bodyStart >= 0 && bodyEnd >= bodyStart ? { responseBody: diagnostic.slice(bodyStart, bodyEnd + 1) } : {}),
  })
  if (failure) return failure
  if (typeof fields.api_error_status === "number" || prefixStatus) return undefined
  // These are the CLI's documented terminal transport messages. The provider
  // boundary above is required; a tool saying "Request timed out" is not one.
  // https://code.claude.com/docs/en/errors#unable-to-connect-to-api
  const transport = diagnostic.replace(/^API Error:\s*/i, "").trim()
  if (/^(?:Request timed out\.?|Connection timed out\.?)(?: Check your internet connection and proxy settings\.?)?$/i.test(transport) ||
    /^No response from API(?:\s*\(|\.|$)/i.test(transport) ||
    /^Stream idle timeout - no chunks received\b/i.test(transport) ||
    /^Unable to connect to API \(ETIMEDOUT\)$/i.test(transport))
    return { kind: "unavailable", retryable: true, code: "timeout" }
  if (/^Connection error\.?$/i.test(transport) ||
    /^Unable to connect to API(?:\. Check your internet connection| \((?:ECONNREFUSED|ConnectionRefused|ECONNRESET|ENOTFOUND|FailedToOpenSocket|EAI_AGAIN|EHOSTUNREACH|ERR_PROXY_TUNNEL)\))?$/i.test(transport) ||
    /^Connection refused — a firewall or proxy may be blocking it \((?:ConnectionRefused|ECONNREFUSED)\)$/.test(transport) ||
    /^Can't reach the API server — check your internet or DNS \((?:ENOTFOUND|FailedToOpenSocket)\)$/.test(transport) ||
    /^Connection dropped \(ECONNRESET\)$/.test(transport))
    return { kind: "unavailable", retryable: true, code: "connection_error" }
  return undefined
}

/** The iterator can also throw an API SDK exception instead of a result. */
function claudeProviderException(error: unknown): ProviderFailure | undefined {
  if (!(error instanceof Error) || ![
    "APIError", "AuthenticationError", "RateLimitError", "InternalServerError",
    "PermissionDeniedError", "APIConnectionError", "APIConnectionTimeoutError", "APITimeoutError",
  ].includes(error.name)) return undefined
  return classifyProviderFailure(error)
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.slice(-4000)
  if (Array.isArray(content)) {
    // ToolSearch answers with tool_reference parts only: show the tools it loaded.
    return content
      .map((part: { type?: unknown; text?: unknown; tool_name?: unknown }) =>
        typeof part?.text === "string"
          ? part.text
          : part?.type === "tool_reference" && typeof part.tool_name === "string"
            ? part.tool_name
            : "",
      )
      .join("\n")
      .slice(-4000)
  }
  return ""
}

/** Normalize only failed SDK results, before their diagnostics become display strings. */
export function captureClaudeRunFailure(error: unknown, context: RunFailureContext): RunFailure {
  if (failureFrom(error) || !error || typeof error !== "object") return captureRunFailure(error, context)
  const value = error as Record<string, unknown>
  if (value.type !== "result" || value.is_error !== true) return captureRunFailure(error, context)
  const candidates = [value.result, ...(Array.isArray(value.errors) ? value.errors : [])]
  const diagnostic = candidates.find((item): item is string => typeof item === "string" && /^API ?[Ee]rror:\s*[45]\d\d\b/.test(item))
  const prefix = diagnostic?.match(/^API ?[Ee]rror:\s*([45]\d\d)\s*([\s\S]*)$/)
  const status = typeof value.api_error_status === "number" ? value.api_error_status : prefix ? Number(prefix[1]) : undefined
  const terminalCodes: Record<string, string> = { prompt_too_long: "context_window_exceeded", image_error: "invalid_request", model_error: "model_unavailable" }
  const terminalCode = typeof value.terminal_reason === "string" ? terminalCodes[value.terminal_reason] : undefined
  const failure = claudeProviderFailure(error as SDKResultMessage, undefined)
  return captureRunFailure({ provider: "claude", ...(status === undefined ? {} : { status }),
    ...(terminalCode ?? failure?.code ? { code: terminalCode ?? failure?.code } : {}),
    ...(prefix ? { message: `API Error: ${prefix[1]} ${prefix[2]}` } : {}), cause: error,
  }, context)
}

/**
 * Unattended: no background shells or scheduled wake-ups that would
 * outlive the turn, no auto-memory written for later sessions.
 */
export const CLAUDE_RUN_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // The CLI owns exponential backoff within the existing session. Do not
  // multiply those retries by restarting a run or its cloud machine.
  CLAUDE_CODE_MAX_RETRIES: "2",
  CLAUDE_CODE_RETRY_WATCHDOG: "0",
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
    const uuid = randomUUID()
    this.items.push({
      type: "user",
      uuid,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
    this.wake()
    return uuid
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

function claudePrewarmOptionsKey(options: SessionOptions) {
  const { cwd, env, credential, github, apps, mcp, mcpHttpObservationUrl, machineEnvironment,
    kind, mode, factoryCheck, verifyCommand, networkAllow, policy, policyHash, skills, skillReceipt, model, effort, runId, requireSessionResume } = options
  return JSON.stringify({ cwd, env, credential, github, apps, mcp, mcpHttpObservationUrl, machineEnvironment,
    kind, mode, factoryCheck, verifyCommand, networkAllow, policy, policyHash, skills, skillReceipt, model, effort, runId, requireSessionResume,
    mailbox: options.mailbox?.tools })
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

  /** Trusted hosted fresh-task path. The same open/account/input logic runs
   * after checkout; no separate adapter or alternate CLI is introduced. */
  startPrepared(options: StartOptions, binding: ClaudePrewarmBinding, control: ClaudePreparation, stop: () => Promise<void>): Promise<AgentSession> {
    if (!options.machineEnvironment || !this.options.spawnHosted || !this.options.subscriptionAuth ||
      options.continueSession || options.requireSessionResume) throw Error('Claude preparation requires a fresh hosted subscription')
    return this.open(binding.sessionId, 'new', options.prompt, options, { binding, control, stop })
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
    preparation?: { binding: ClaudePrewarmBinding; control: ClaudePreparation; stop(): Promise<void> },
  ): Promise<AgentSession> {
    const approval = requireRunToolApproval(options.runId, options.toolApproval)
    if (!await approval.checkLive()) { approval.revoke(); throw new Error('Run tool approval unavailable') }
    // Read-only is the policy's own fact, not a mode the adapter must guess.
    const policy = runPolicy(options.policy)
    const paths = runPaths(this.options.stateDir, options.runId)
    const runDir = await claimRunDir(paths)
    const externalAuth = this.options.subscriptionAuth
    let nativeToken: string | undefined
    let expiresAt = 0
    if (externalAuth) {
      if(externalAuth.brokered && !this.options.spawnHosted)throw new Error(SUBSCRIPTION_ERROR)
      const clean = options.machineEnvironment ? options.env : taskExecutionEnv(buildChildEnv({
        host: options.env,
        runId:
          options.env.MIKKA_RUN_ID === undefined ? undefined : options.runId
      }), options)
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
      } catch (error) {
        throw new Error(SUBSCRIPTION_ERROR, { cause: error })
      }
    }
    // Never the host's login or config. This is config isolation only; a
    // hosted runner still requires an owner security boundary.
    const nativeHome = options.machineEnvironment ? options.env.HOME : join(runDir, "native-home")
    if (!nativeHome) throw new Error('Cloud machine HOME unavailable')
    const configDir = options.machineEnvironment ? options.env.CLAUDE_CONFIG_DIR ?? join(nativeHome, '.claude') : join(nativeHome, ".claude")
    if (!options.machineEnvironment) { ownDir(nativeHome); ownDir(configDir) }
    if (!options.machineEnvironment && mode === "continue" && options.continueSession) {
      carryHistory(join(runPaths(this.options.stateDir, options.continueSession.runId).runDir, "native-home", ".claude"), configDir, ["projects"])
    }
    if (externalAuth && options.credential) throw new Error(SUBSCRIPTION_ERROR)
    const credentialEnv = claudeCredentialEnv(options.credential)
    const providerDomain = credentialDomain(options.credential)
    const computerMcp = this.options.computerMcp ?? this.options.computerProvider?.(options.runId, options.policy)
    const binary = this.options.binary ?? (this.options.spawnHosted ? undefined : await this.options.ensureBinary?.())
    const contextOptions = (preparing = false): RunContextOptions => ({
      harnessDomains: providerDomain ? [providerDomain] : undefined,
      github: options.github,
      githubEnvironment: options.githubEnvironment,
      mcp: options.mcp,
      mcpHttpObservationUrl: options.mcpHttpObservationUrl,
      apps: options.apps,
      githubRuntime: options.githubRuntime,
      machineEnvironment: options.machineEnvironment,
      childPath: options.env.PATH,
      mailboxEnabled: Boolean(options.mailbox),
      harness: "claude_code",
      kind: options.kind,
      factoryCheck: options.factoryCheck,
      verifyCommand: options.verifyCommand,
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
      extraWrite: preparing ? [] : [
        join(configDir, "projects", claudeProjectDirName(options.cwd)),
        join(
          configDir,
          "projects",
          claudeProjectDirName(realpathSync(options.cwd)),
        ),
      ],
    })
    const files = preparation ? prepareRunContextFiles(contextOptions(true)) : undefined
    let ctx!: RunContext
    if (!preparation) ctx = new RunContext(contextOptions())

    const log = options.log.child({
      harness: "claude_code",
      session_id: sessionId,
    })
    // A hand-in the last daemon never got to act on ends the session now.
    // The run dir is this run's own: a follow-up never sees the earlier
    // run's hand-in.
    const earlier = mode === "restart" ? ctx!.readHandoff(log) : null
    if (earlier) return endedSession(sessionId, earlier)
    if (!preparation) ctx!.clearHandoff()

    const queue = new EventQueue()
    let prompts: Pick<PromptQueue, "push" | "close"> = new PromptQueue(sessionId)
    let closePrepared: (() => Promise<void>) | undefined
    let firstPromptId: string | undefined
    let written = 0
    let results = 0
    let runtimeModel: string | null = null
    let ending = false
    let failureDetails: RunFailure | undefined
    let lastError: string | undefined
    let providerFailure: ProviderFailure | undefined
    /** The API error the current turn's assistant message carried, if any. */
    let assistantError: unknown
    /** The CLI's quota or rate-limit failure seen this turn, if any. */
    let quota: QuotaSignal | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let authTimer: NodeJS.Timeout | undefined
    let stderr = ""
    let stderrArrived: () => void = () => undefined
    const firstStderr = new Promise<void>(resolve => { stderrArrived = resolve })
    const stderrTail = () => stderr.slice(-STDERR_TAIL).trim() || "no output"
    /** True once the session proved open, false if the CLI failed first. */
    let spoke: (value: boolean) => void = () => undefined
    const spoken = new Promise<boolean>((resolve) => (spoke = resolve))
    let checkingContinuation = mode === "continue"
    /** The SDK stream has settled; native process exit is confirmed separately. */
    let finished: () => void = () => undefined
    const gone = new Promise<void>((resolve) => (finished = resolve))
    let nativeExit = Promise.resolve(false)

    if(externalAuth && this.options.onHostedSession) {
      try{await this.options.onHostedSession(sessionId)}catch(error){throw new Error(SUBSCRIPTION_ERROR, { cause: error })}
    }
    // No sandbox: the CLI starts directly. A revoked run gate stops it.
    const spawnLocal = (config: SpawnOptions): SpawnedProcess & { stderr?: Readable } => {
      const child = spawnBinary(binary, nativeToken)(config)
      const off = options.toolApproval!.onRevoke(() => { child.kill("SIGTERM") })
      child.once("exit", off)
      return child
    }
    const credentialSecrets = [nativeToken, options.credential?.key].filter((value): value is string => Boolean(value && value !== NATIVE_AUTH_PLACEHOLDER))
    const sensitiveText = [firstMessage, options.prompt ?? "", options.continueSession?.message ?? "", options.apps?.token ?? ""]
    const capture = (error: unknown) => captureClaudeRunFailure(error, { runId: options.runId, appVersion: DAEMON_VERSION, provider: "claude", credential: options.credential ? "api_key" : "subscription", sensitiveText: [...sensitiveText, ...credentialSecrets] })
    const refreshOptions = externalAuth?.automaticRefresh ? {
      getOAuthToken: async ({ signal }: { signal: AbortSignal }): Promise<string | null> => {
        if (signal.aborted || approval.revoked || ending) return null
        const value = await externalAuth.token()
        if (value.accountId !== externalAuth.accountId || !value.accessToken || /[\r\n\0]/.test(value.accessToken) ||
          Date.parse(value.expiresAt) <= Date.now()) return null
        nativeToken = value.accessToken
        expiresAt = Date.parse(value.expiresAt)
        if (!credentialSecrets.includes(nativeToken)) credentialSecrets.push(nativeToken)
        options.onCredential?.('SUBSCRIPTION_ACCESS_TOKEN', nativeToken)
        return nativeToken
      },
    } : {}
    const traceContext = options.traceContext ?? daemonTracer.capture()
    const generations = new ClaudeGenerationMetrics(metrics => daemonTracer.generation(metrics, traceContext))
    const observeNative = (child: SpawnedProcess & { stderr?: Readable }, previousStderr = '') => {
      if (previousStderr) { stderr = previousStderr.slice(-STDERR_TAIL * 4); stderrArrived() }
          nativeExit = new Promise<boolean>(resolve => {
            child.once('exit', () => resolve(true))
            // A spawn/transport error must not leave shutdown waiting for an
            // exit that cannot arrive, or attest that a live process is gone.
            child.once('error', () => resolve(false))
            if (child.exitCode !== null || child.signalCode) resolve(true)
          })
          // Capture the actual pipe. The SDK's stderr callback can remain
          // empty for a custom spawn, including when a result precedes exit.
          child.stderr?.on('data', (data: Buffer | string) => {
            stderr = (stderr + data.toString()).slice(-STDERR_TAIL * 4)
            stderrArrived()
          })
    }
    const sdkOptions = (context: Pick<RunContext, "worktree" | "tmpDir" | "tempEnv" | "mcpServer">, append: string): Options => ({
        ...refreshOptions,
        includePartialMessages: daemonTracer.enabled,
        cwd: context.worktree,
        // The official CLI echoes the exact stdin user frame after reading
        // it. Its UUID distinguishes this task from init and resumed history.
        extraArgs: { 'replay-user-messages': null },
        // Hosted options contain the full machine environment; personal
        // runs retain their existing child environment preparation.
        env: {
          ...options.env,
          ...context.tempEnv(),
          ...CLAUDE_RUN_ENV,
          CLAUDE_CODE_TMPDIR: context.tmpDir,
          ...credentialEnv,
          ...(!options.machineEnvironment ? { HOME: nativeHome, CLAUDE_CONFIG_DIR: configDir } : {}),
        },
        settingSources: options.machineEnvironment ? ["user", "project", "local"] : [],
        settings: {
          ...claudeSettings(options.policy),
          ...(externalAuth ? { forceLoginMethod: "claudeai" as const } : {})
        },
        mcpServers: {
          ...(options.mailbox ? { mikka_mailbox: claudeMailboxServer(options.mailbox) } : {}),
          [MCP_SERVER_NAME]: { type: "stdio", ...context.mcpServer() },
          ...(computerMcp ? { [COMPUTER_MCP_SERVER_NAME]: { type: "stdio" as const, ...computerMcp } } : {}),
          ...claudeAppServers(options.apps),
        },
        strictMcpConfig: !options.machineEnvironment,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: append,
        },
        // Two independent facts decide this, and neither is a thread mode:
        //
        // - A read-only policy changes nothing, so the CLI asks nothing and
        //   is refused the tools that would. This is ADR 0046, and it applies
        //   whatever the workspace allowed.
        // - A run whose policy resolves an action to `ask` routes that
        //   tool to the run-bound approval gate and waits for the person.
        //   A policy with no such action keeps the historical behavior:
        //   nothing is asked per tool (decision 2026-11-01-2335).
        ...(policy.readOnly ? {
          permissionMode: "default" as const,
          canUseTool: async (name: string, args: Record<string, unknown>) =>
            PLANNING_READ_TOOLS.has(name) || isHostTool(name) || isAppTool(name)
              ? { behavior: "allow" as const, updatedInput: args }
              : { behavior: "deny" as const, message: "This run only reads; hand your findings back instead of changing anything." },
        } : approval.asksAny ? {
          permissionMode: "default" as const,
          canUseTool: async (name: string, args: Record<string, unknown>, context: CanUseToolContext) => {
            if (PLANNING_READ_TOOLS.has(name) || isHostTool(name) || isAppTool(name) || isComputerTool(name))
              return { behavior: "allow" as const, updatedInput: args }
            const approved = await approval.requestApproval({
              requestId: context?.requestId ?? context?.toolUseID ?? randomUUID(),
              method: "tool" as const, tool: name, input: args,
            }, context?.signal)
            return approved
              ? { behavior: "allow" as const, updatedInput: args }
              : { behavior: "deny" as const, message: "The person did not approve this operation." }
          },
        } : {
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
        }),
        ...(mode === "new" ? { sessionId } : { resume: sessionId }),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        // The hosted runner passes the actual credential to the official CLI.
        spawnClaudeCodeProcess: (config: SpawnOptions) => {
          const child = this.options.spawnHosted
            ? this.options.spawnHosted(config, nativeToken)
            : spawnLocal(config)
          observeNative(child)
          return child
        },
    })
    let anonymousClaimed = false
    let session: ReturnType<typeof query>
    if (preparation) {
      const { binding, control } = preparation
      // Only instructions, prompt attachments and validated Git metadata may
      // arrive after clone. All process/MCP/credential options are immutable.
      const fixed = claudePrewarmOptionsKey(options)
      const parking = join(runDir, 'claude-parking')
      ownDir(parking)
      let anonymousAdopted = false
      const prepared = prepareClaudeSession({ binding, signal: control.signal, stop: preparation.stop,
        assertLive: () => { if (approval.revoked) throw Error('Run tool approval unavailable'); control.signal.throwIfAborted() },
        prepare: async abortController => {
            const sdk = sdkOptions(files!, '')
            const candidate = this.options.anonymousClaudeCandidate
            if (candidate && this.options.anonymousClaudeFresh && nativeToken && refreshOptions.getOAuthToken) {
              const value = await candidate.adopt({ identity: this.options.anonymousClaudeFresh, options: sdk,
                context: runMcpBackendContext(contextOptions(true), files!, sdk.env ?? {}),
                authority: { signal: control.signal, assertLive: () => { control.signal.throwIfAborted(); if (approval.revoked) throw Error('Run tool approval unavailable') } },
                mailbox: options.mailbox, oauthToken: nativeToken, getOAuthToken: refreshOptions.getOAuthToken, observe: observeNative,
              })
              if (value) { anonymousAdopted = true; return value }
            }
            return daemonTracer.span('daemon.adapter.cli_init.prewarm',
              { 'mikka.harness': 'claude_code', 'mikka.run.id_hash': runIdHash(options.runId) },
              () => prewarm({ initializeTimeoutMs: INITIALIZATION_TIMEOUT_MS, options: { ...sdk, cwd: parking, abortController } }))
          },
      })
      try {
        await prepared.ready
        control.parked()
        const finalOptions = await control.finalOptions
        control.signal.throwIfAborted()
        if (fixed !== claudePrewarmOptionsKey(finalOptions) || !await approval.checkLive()) throw Error('Claude prepared options changed')
        options = finalOptions
        firstMessage = finalOptions.prompt
        sensitiveText.push(firstMessage)
        ctx = new RunContext(contextOptions())
        ctx.clearHandoff()
        if (anonymousAdopted) await this.options.anonymousClaudeCandidate!.bindContext(
          runMcpBackendContext(contextOptions(), ctx, sdkOptions(ctx, '').env ?? {}))
        try {
          const claimed = await prepared.consume({ binding, appendSystemPrompt: ctx.instructions(),
            verify: async (_query, signal) => { signal.throwIfAborted(); if (!await approval.checkLive()) throw Error('Run tool approval unavailable') },
          })
          anonymousClaimed = anonymousAdopted
          session = claimed.query
          closePrepared = claimed.close
          prompts = { push: claimed.send, close: () => { void claimed.close().catch(() => undefined) } }
        } catch (error) {
          // consume already drained this precise refused claim. No other
          // initialization, auth, binding, cancellation or post-input error
          // can silently create a replacement session.
          if (!(error instanceof ClaudeProjectSettingsNotClaimable)) throw error
          control.signal.throwIfAborted()
          if (!await approval.checkLive()) throw Error('Run tool approval unavailable', { cause: error })
          session = query({ prompt: prompts as PromptQueue, options: sdkOptions(ctx, ctx.instructions()) })
        }
      } catch (error) { await prepared.cancel(); throw error }
    } else session = query({ prompt: prompts as PromptQueue, options: sdkOptions(ctx!, ctx!.instructions()) })


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
      const processExited = await nativeExit
      await closePrepared?.()
      wipeRunCredentials(runDir)
      if (event) {
        const { failureDetails: supplied, ...terminal } = event
        queue.exit({ ...terminal, ...(event.outcome === "failed" ? { failureDetails: supplied ?? failureDetails ?? capture(new Error("claude_cli_exited_early")) } : {}), ...(processExited ? {} : { sessionExited: false as const }) })
      }
    }
    const turnEnded = () => {
      const handoff = ctx.readHandoff(log)
      if (handoff) return void end(handoff)
      void end(
        lastError
          ? { outcome: "failed", error: lastError, ...(quota ? { quota } : {}), ...(providerFailure ? { providerFailure } : {}) }
          : { outcome: "succeeded" },
      )
    }
    // The native text can hold the lease: only redacted copies reach the log,
    // and the run's error names a fixed class.
    const secrets = credentialSecrets
    const subscriptionFailure = (category: string, fields: Record<string, unknown>) => {
      try {
        log.warn({
          event: "claude_subscription_turn_failed",
          category,
          ...fields,
          ...(typeof assistantError === "string" ? { assistant_error: assistantError.slice(0, 64) } : {}),
          stderr: redactDiagnostic(stderrTail(), secrets),
        }, "claude subscription turn failed")
      } catch { /* The run's own failure still ends it. */ }
      return `${SUBSCRIPTION_EXECUTION_ERROR} (${category})`
    }
    const diedEarly = (error: string, failure?: ProviderFailure) => {
      ending = true
      providerFailure = failure ?? providerFailure ?? classifyProviderFailure({ code: assistantError })
      const handoff = ctx.readHandoff(log)
      // A missing continuation may be replaced by the caller below. Close
      // this transport without revoking the gate that the fresh open rechecks.
      const retryingContinuation = checkingContinuation && !options.requireSessionResume && !externalAuth && !providerFailure
      void end(
        handoff ?? {
          outcome: "failed",
          error: externalAuth
            ? subscriptionFailure(CLI_EXITED_EARLY, { detail: redactDiagnostic(error, secrets, 500) })
            : providerFailure ? providerFailureMessage(providerFailure) : `claude exited before the turn ended: ${error}`,
          ...(quota ? { quota } : {}),
          ...(providerFailure ? { providerFailure } : {}),
        },
        !retryingContinuation,
      )
    }

    void (async () => {
      try {
        for await (const message of session) {
          generations.observe(message)
          if (
            options.requireSessionResume &&
            "session_id" in message &&
            typeof message.session_id === "string" &&
            message.session_id !== sessionId
          )
            throw new Error("Claude resumed a different question session")
          if (!ending && firstPromptId && message.type === 'user' && message.session_id === sessionId &&
            message.uuid === firstPromptId && message.parent_tool_use_id == null)
            runRuntimeTimings.agentAccepted(options.runId, 'claude_user_ack')
          if (message.type === "system" && message.subtype === "init" && typeof message.model === "string")
            runtimeModel = message.model || null
          if (message.type === "assistant" && message.parent_tool_use_id == null && typeof message.message.model === "string")
            runtimeModel = message.message.model || null
          if (runtimeModel && ((message.type === "system" && message.subtype === "init") ||
            (message.type === "assistant" && message.parent_tool_use_id == null)))
            options.onRuntimeModel?.(sessionId, runtimeModel)
          if (provesSession(message)) {
            checkingContinuation = false
            spoke(true)
          }
          // A new turn (the queued message) produces its own result.
          if (message.type === "assistant" || message.type === "user")
            clearTimeout(graceTimer)
          if (message.type === "assistant" && message.parent_tool_use_id == null && message.error) assistantError = message.error
          if (ending) continue
          quota = mergeQuota(quota, claudeQuotaSignal(message))
          if (message.type === 'tool_progress' && message.session_id === sessionId) queue.progress()
          // CLI API errors can contain provider diagnostics or credentials;
          // they are not assistant output, on either API keys or subscriptions.
          if (!(message.type === "assistant" && message.error))
            for (const chunk of claudeChunks(message)) queue.chunk(chunk)
          if (message.type !== "result") continue
          results++
          failureDetails = message.is_error ? capture(message) : undefined
          providerFailure = claudeProviderFailure(message, assistantError)
          if (!message.is_error) quota = undefined
          // stdout and stderr are separate pipes. A result can be delivered
          // before an earlier diagnostic's data callback, so briefly drain
          // that pipe before freezing the failure record.
          if (message.is_error && externalAuth && !stderr) {
            let drainTimer: NodeJS.Timeout | undefined
            await Promise.race([firstStderr, new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 100) })])
            clearTimeout(drainTimer)
          }
          lastError = message.is_error
            ? externalAuth
              ? subscriptionFailure(subscriptionFailureCategory(message, assistantError), resultDiagnostics(message, secrets))
              : providerFailure ? providerFailureMessage(providerFailure) : `Claude Code: ${resultError(message)}`
            : undefined
          assistantError = undefined
          if (providerFailure || results >= written) {
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
        generations.fail()
        if (!ending) {
          failureDetails = capture(error)
          diedEarly(errorMessage(error), claudeProviderException(error))
        }
      } finally {
        clearTimeout(authTimer)
        spoke(false)
        finished()
      }
    })()

    // New direct runners use the pinned SDK's oauth_token_refresh callback
    // and a background lease cache. Legacy callers without that cache retain
    // their old expiry behavior; no rotating refresh grant reaches a CLI.
    authTimer = externalAuth && !externalAuth.brokered && !externalAuth.automaticRefresh
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
      const traceAttributes = { "mikka.harness": "claude_code", "mikka.run.id_hash": runIdHash(options.runId) }
      let offRevoke: (() => void) | undefined
      let authPhase: 'initialization' | 'account_info' | 'external_verify' = 'initialization'
      let authReason: 'initialization_failed' | 'timeout' | 'revoked' | 'session_closed' | 'provider_refused' | 'source_refused' | 'verify_refused' = 'initialization_failed'
      try {
        // accountInfo waits for this same SDK initialization promise. Give the
        // cold CLI an explicit bounded startup budget before checking its
        // account; no prompt is released until all checks below pass.
        await daemonTracer.span("daemon.adapter.cli_init", traceAttributes, () => Promise.race([
          session.initializationResult(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => { authReason = 'timeout'; reject(new ClaudeInitializationError(true)) },
              INITIALIZATION_TIMEOUT_MS
            )
          }),
          new Promise<never>((_, reject) => {
            offRevoke = approval.onRevoke(() => {
              authReason = 'revoked'
              reject(new ClaudeInitializationError(false))
            })
          }),
        ]))
        clearTimeout(timer)
        authPhase = 'account_info'
        const account = await daemonTracer.span("daemon.adapter.account_check.account_info", traceAttributes, () => session.accountInfo())
        authReason = ending ? 'session_closed' : account.apiProvider !== 'firstParty' ? 'provider_refused' : 'source_refused'
        if (
          ending ||
          account.apiProvider !== "firstParty" ||
          // Current Claude Code omits apiKeySource for the descriptor we
          // supplied. Require that exact OAuth source when it is absent;
          // an adopted spare instead received that exact OAuth token through
          // official ClaimOptions.env. No unknown source or API key may pass.
          !(account.apiKeySource === "none" ||
            (account.apiKeySource === undefined && (account.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ||
              (anonymousClaimed && account.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN"))))
        )
          throw new Error(SUBSCRIPTION_ERROR)
        authPhase = 'external_verify'
        authReason = 'verify_refused'
        await daemonTracer.span("daemon.adapter.account_check", traceAttributes, async () => { await externalAuth.verify?.() })
        if (ending || approval.revoked) throw new Error(SUBSCRIPTION_ERROR)
        this.options.anonymousClaudeCandidate?.recordAuthentication(anonymousClaimed, account.tokenSource, account.apiKeySource)
      } catch (error) {
        // Cleanup revokes the gate too; detach before preserving the failure.
        offRevoke?.()
        try { log.warn({ event: 'claude_subscription_startup_failed', phase: authPhase, reason: authReason }, 'Subscription startup failed') } catch { /* Keep the original refusal. */ }
        await end(null)
        if (authPhase === 'initialization') throw error instanceof ClaudeInitializationError ? error : new ClaudeInitializationError(false)
        throw new Error(SUBSCRIPTION_ERROR, { cause: error })
      } finally {
        clearTimeout(timer)
        offRevoke?.()
      }
    }
    firstPromptId = prompts.push(firstMessage)
    written++
    if (mode === "continue" && !(await untilSpoken(spoken))) {
      if (providerFailure) {
        await end(null)
        throw Object.assign(new ProviderFailureError(providerFailure), { failureDetails })
      }
      if (options.requireSessionResume || externalAuth) {
        await end(null)
        throw new Error(externalAuth ? SUBSCRIPTION_ERROR : 'Original Claude question session is unavailable; refusing a fresh session')
      }
      log.info(
        { stderr: redactDiagnostic(stderrTail(), secrets) },
        "could not continue the earlier claude session; starting a new one",
      )
      // Close the failed transport and its pending callbacks. The same live
      // run retries once with a fresh transport, retaining its trusted gate.
      await end(null, false)
      return this.open(randomUUID(), "new", options.prompt ?? "", options)
    }
    checkingContinuation = false
    log.info({ mode, sandbox: "claude-code" }, "claude session started")

    return {
      sessionId,
      get runtimeModel() { return runtimeModel },
      events: () => queue.drain(),
      async send(text) {
        if (ending) throw new Error("The Claude session already ended")
        if (externalAuth?.verify) {
          try { await externalAuth.verify() } catch (error) { await end({ outcome: 'failed', error: SUBSCRIPTION_ERROR }); throw new Error(SUBSCRIPTION_ERROR, { cause: error }) }
        }
        if (externalAuth && !externalAuth.brokered && !externalAuth.automaticRefresh && Date.now() >= expiresAt) {
          await end({ outcome: "failed", error: SUBSCRIPTION_ERROR })
          throw new Error(SUBSCRIPTION_ERROR)
        }
        sensitiveText.push(text)
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
