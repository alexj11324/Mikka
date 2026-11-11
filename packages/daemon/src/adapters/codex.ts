import type { AnonymousCodexCandidate } from '../anonymous-codex-spare'
import type { FreshCandidate } from '../anonymous-claude-spare'
import { captureRunFailure, failureFrom, type RunFailure, type RunFailureContext } from "@mikka/protocol/run-failure"
import { codexFailureInfo, codexFailureMessage, type CodexFailureInfo, type CodexFailurePhase } from "./codex-failure"
import { codexQuotaSignal, mergeQuota, type CodexRateLimits, type QuotaSignal } from "../runs/quota-exhausted"
// Codex adapter (ADR 0003): the user's own signed-in `codex app-server`,
// one process per session, run directly (no sandbox; approvals "never" and
// sandbox "danger-full-access", decision 2026-11-01-2335), with an isolated
// `CODEX_HOME` (see `agents/harness-home.ts`). Thread = session: `thread/start`
// or `thread/resume`, then `turn/start`; a message during a turn is a
// `turn/steer`, one between turns starts the next turn. Threads live in the
// run's `CODEX_HOME`, so a follow-up run copies the earlier run's
// `sessions` into its own before `thread/resume`.
import { delimiter, dirname, isAbsolute, join, relative } from "node:path"
import { mkdirSync } from "node:fs"
import { daemonTracer, runIdHash } from "../tracing"
import { CodexGenerationMetrics } from './generation-metrics'
import { codexGenerationReceiptAttributes, codexTraceEnvironment, startCodexGenerationCollector } from '../codex-generation-telemetry'
import type { GenerationMetrics } from '../tracing-ai'
import { runRuntimeTimings } from '../run-runtime-timing'

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
  prepareCodexHome,
  wipeRunCredentials,
} from "../agents/harness-home"
import { codexCredential, credentialDomain } from "../agents/run-credential"
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
import type { RunApps } from "../agents/run-apps"
import { rawCliShellAvailable, runPolicy } from "../permissions"
import type { RunChunk } from "../chunks"
import { DAEMON_VERSION } from "../paths"
import { buildChildEnv } from "../env"
import { taskExecutionEnv } from '../task-env'
import { mailboxToolResult } from '../run-mailbox'
import { codexMailboxCatalogue, codexMailboxResumeVersion, recordCodexMailboxSession, verifyCodexMailboxResume } from './codex-mailbox'
import { NATIVE_AUTH_PLACEHOLDER } from '../subscription-native-broker'
import { classifyProviderFailure, ProviderFailureError, providerFailureMessage, type ProviderFailure } from "@mikka/protocol/provider-failure"
import type {
  DeltaNotification,
  ErrorNotification,
  ItemNotification,
  RateLimitsNotification,
  ThreadItem,
  ThreadResponse,
  ThreadResumeParams,
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
  anonymousCodexCandidate?: AnonymousCodexCandidate
  anonymousCodexFresh?: FreshCandidate
  sandbox: AgentSandbox
  /** The daemon's adapter state dir (per-run dirs and homes live under it). */
  stateDir: string
  binary?: string
  /** The daemon's pinned Codex, installed on first need. */
  ensureBinary?: () => Promise<string>
  /** Trusted hosted transport, retaining the existing app-server adapter. */
  spawnCli?: typeof spawnCli
  /** Trusted acceptance-only logs configuration, applied before native traces. */
  cliTiming?: { env: Record<string, string>; args: string[] }
  /** Persist an owner-bound session before any prompt can execute. */
  onHostedSession?(sessionId:string):Promise<void>
  /** Supplied only by trusted hosted infrastructure for this run. */
  computerMcp?: McpServerSpec
  computerProvider?: ComputerSpecProvider
  /** @deprecated Ignored: the person's own `CODEX_HOME` is never read. */
  userHome?: string
  /** Only the trusted hosted spawn may route a subscription through Mikka's
   * private run broker. The CLI receives a public transport marker, no OAuth
   * token or claimed ChatGPT identity. Direct/local OAuth uses subscriptionAuth. */
  hostedSubscriptionBroker?: { verify(): Promise<void> }
  /** Trusted, owner-bound broker only; never a task/model-supplied credential. */
  subscriptionAuth?: {
    accountId: string
    verify?(): Promise<void>
    /** `true` handles the official app-server's explicit token-refresh request. */
    token(forceRefresh: boolean): Promise<ChatGPTAuthTokens>
  }
}

const SUBSCRIPTION_AUTH_ERROR = "Codex subscription authentication unavailable"

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

/** One streamable-HTTP MCP entry per connected app, each pointing at the Mikka server. */
export function codexAppArgs(apps?: RunApps): string[] {
  return (apps?.apps ?? []).flatMap(app => [
    "-c", `mcp_servers.${app.name}.url=${toml(app.url)}`,
    "-c", `mcp_servers.${app.name}.http_headers={ Authorization = ${toml(`Bearer ${apps!.token}`)} }`,
  ])
}

/** TOML value for a `-c key=value` override (JSON strings are TOML strings). */
function toml(value: string | string[]): string {
  return JSON.stringify(value)
}

function text(value: string): UserInput[] {
  return [{ type: "text", text: value, text_elements: [] }]
}

/** Only a terminal app-server provider error may reach this classifier. */
export function codexProviderFailure(error: unknown): ProviderFailure | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as Record<string, unknown>
  // turn/start can reject through JSON-RPC's structured error data.
  if (value.data && typeof value.data === "object" && "codexErrorInfo" in value.data) {
    const data = value.data as Record<string, unknown>
    return codexProviderFailure({ ...data, message: typeof data.message === "string" ? data.message : value.message })
  }
  const info = codexFailureInfo(error)
  const categories: Partial<Record<CodexFailureInfo["category"], string>> = {
    unauthorized: "authentication_failed", rateLimitExceeded: "rate_limit",
    serverOverloaded: "overloaded", flexUnavailable: "overloaded", internalServerError: "server_error",
    httpConnectionFailed: "connection_error", responseStreamConnectionFailed: "connection_error",
    responseStreamDisconnected: "connection_error", responseTooManyFailedAttempts: "connection_error",
  }
  const category = categories[info.category]
  const unspecified = ["unknown", "other", "rpc_refused"].includes(info.category)
  const modelRefusal = info.category === "badRequest"
  if (!category && !unspecified && !modelRefusal) return undefined
  const httpError = ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].includes(info.category)
  const diagnostic = (httpError || unspecified || modelRefusal) && typeof value.message === "string" ? value.message : ""
  const bodyStart = diagnostic.indexOf("{")
  const bodyEnd = diagnostic.lastIndexOf("}")
  const prefixStatus = /^(?:stream disconnected before completion:\s*)?(?:unexpected status|HTTP status|API Error:)\s*([1-5]\d{2})\b/i.exec(diagnostic)?.[1]
  // Some official versions retain only this native API status prefix in the
  // terminal error. No arbitrary model/tool HTTP text is searched.
  if ((unspecified || modelRefusal) && !prefixStatus) {
    const failure = classifyProviderFailure(error)
    return modelRefusal && failure?.kind !== "model" ? undefined : failure
  }
  const failure = classifyProviderFailure({
    status: info.httpStatus ?? (prefixStatus ? Number(prefixStatus) : undefined),
    code: category,
    ...(bodyStart >= 0 && bodyEnd >= bodyStart ? { responseBody: diagnostic.slice(bodyStart, bodyEnd + 1) } : {}),
  })
  return modelRefusal && failure?.kind !== "model" ? undefined : failure
}

/** Turn errors are a trusted CLI boundary; arbitrary messages elsewhere are not. */
export function captureCodexRunFailure(error: unknown, context: RunFailureContext): RunFailure {
  if (failureFrom(error)) return captureRunFailure(error, context)
  if (!error || typeof error !== "object") return captureRunFailure(error, context)
  const outer = error as Record<string, unknown>
  const data = outer.data && typeof outer.data === "object" ? outer.data as Record<string, unknown> : undefined
  const value = data && "codexErrorInfo" in data ? { ...data, message: typeof data.message === "string" ? data.message : outer.message } : outer
  const info = codexFailureInfo(value)
  const codes: Partial<Record<CodexFailureInfo["category"], string>> = {
    unauthorized: "authentication_failed", usageLimitExceeded: "usage_limit_exceeded", contextWindowExceeded: "context_window_exceeded",
    rateLimitExceeded: "rate_limit", serverOverloaded: "overloaded", flexUnavailable: "overloaded", internalServerError: "server_error",
    httpConnectionFailed: "connection_error", responseStreamConnectionFailed: "connection_error", responseStreamDisconnected: "connection_error", responseTooManyFailedAttempts: "connection_error",
  }
  const diagnostic = typeof value.message === "string" ? value.message : ""
  const prefix = /^(?:stream disconnected before completion:\s*)?(?:unexpected status|HTTP status|API [Ee]rror:)\s*([45]\d{2})\b[ :,-]*([\s\S]*)$/i.exec(diagnostic)
  const status = info.httpStatus ?? (prefix ? Number(prefix[1]) : undefined)
  const body = prefix?.[2]
  const start = body?.indexOf("{") ?? -1, end = body?.lastIndexOf("}") ?? -1
  return captureRunFailure({
    provider: "codex", ...(status === undefined ? {} : { status }),
    // A concrete HTTP refusal takes precedence over generic connection labels.
    ...(codes[info.category] && !(status !== undefined && codes[info.category] === "connection_error") ? { code: codes[info.category] } : {}),
    ...(prefix ? { message: `API Error: ${prefix[1]} ${body}` } : {}),
    ...(body && start >= 0 && end >= start ? { responseBody: body.slice(start, end + 1) } : {}),
    cause: error,
  }, context)
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
        // MCP isError results carry a failed status with a null error.
        call.error || call.status === "failed"
          ? {
              type: "tool-output-error",
              toolCallId: item.id,
              errorText: call.error?.message ?? "MCP tool call failed",
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
    const mailboxCatalogue = options.mailbox ? codexMailboxCatalogue(options.mailbox) : undefined
    const paths = runPaths(this.options.stateDir, options.runId)
    const runDir = await claimRunDir(paths)
    const externalAuth = this.options.subscriptionAuth
    const brokerAuth = this.options.hostedSubscriptionBroker
    const managedAuth = Boolean(externalAuth || brokerAuth)
    if (brokerAuth && (!this.options.spawnCli || externalAuth || options.credential)) throw new Error(SUBSCRIPTION_AUTH_ERROR)
    if (managedAuth) {
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
        throw new Error(SUBSCRIPTION_AUTH_ERROR)
    }
    if (!options.machineEnvironment && mode === "continue" && options.continueSession) {
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
        if (options.requireSessionResume || options.mailbox)
          throw new Error("Original Codex question history is unavailable", {
            cause: error,
          })
        log.info({ err: error }, "could not copy the earlier codex threads")
      }
    }
    // Inside the run dir: one run's home is never another run's.
    const codexHome = options.machineEnvironment
      ? { home: options.env.CODEX_HOME ?? join(options.env.HOME, '.codex') }
      : prepareCodexHome(join(runDir, "codex-home"), log)
    if (options.machineEnvironment) mkdirSync(codexHome.home, { recursive: true, mode: 0o700 })
    const mailboxResumeVersion = mailboxCatalogue && threadId ? verifyCodexMailboxResume(
      this.options.stateDir,
      mode === 'continue' ? options.continueSession!.runId : options.runId,
      codexHome.home, threadId, mailboxCatalogue,
    ) : null
    const computerMcp = this.options.computerMcp ?? this.options.computerProvider?.(options.runId, options.policy)
    const binary = this.options.binary ?? await this.options.ensureBinary?.() ?? "codex"
    // The official platform package includes code-mode helpers beside Codex.
    // Only an absolute host-selected CLI directory enters the filtered PATH.
    const childPath = isAbsolute(binary) ? dirname(binary) + delimiter + (options.env.PATH ?? '') : options.env.PATH
    if (externalAuth && options.credential) throw new Error(SUBSCRIPTION_AUTH_ERROR)
    const credential = codexCredential(brokerAuth
      ? { kind: "provider", protocol: "openai", baseUrl: "https://mikka.invalid", key: NATIVE_AUTH_PLACEHOLDER }
      : options.credential)
    const providerDomain = credentialDomain(options.credential)
    const ctx = new RunContext({
      harnessDomains: providerDomain ? [providerDomain] : undefined,
      github: options.github,
      githubEnvironment: options.githubEnvironment,
      mcp: options.mcp,
      mcpHttpObservationUrl: options.mcpHttpObservationUrl,
      apps: options.apps,
      githubRuntime: options.githubRuntime,
      machineEnvironment: options.machineEnvironment,
      childPath,
      mailboxEnabled: Boolean(options.mailbox),
      harness: "codex",
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
      profileSkills: options.profileSkills,
      repositorySkills: options.repositorySkills,
      runDir,
      privateDir: paths.privateDir,
    })
    // A hand-in the last daemon never got to act on ends the session now.
    const earlier = mode === "restart" ? ctx.readHandoff(log) : null
    if (threadId && earlier) return endedSession(threadId, earlier)
    ctx.clearHandoff()
    const mcp = ctx.mcpServer()
    const traceContext = options.traceContext ?? daemonTracer.capture()
    let nativeGenerations: Awaited<ReturnType<typeof startCodexGenerationCollector>> | undefined
    let nativeUnavailableReason: GenerationMetrics['nativeUnavailableReason']
    const closeNativeGenerations = (cliExitObserved: boolean) => {
      if (!nativeGenerations) return
      const drain = nativeGenerations.close(cliExitObserved).then(receipt =>
        daemonTracer.span('daemon.ai.collection', { 'mikka.harness': 'codex', ...codexGenerationReceiptAttributes(receipt) }, async () => {}, { traceContext }))
      daemonTracer.registerGenerationDrain(drain)
      void drain.then(() => daemonTracer.flush()).catch(() => {})
    }
    const argv = [
      binary,
      "app-server",
      "-c", `features.shell_tool=${rawCliShellAvailable(runPolicy(options.policy))}`,
      "-c",
      `mcp_servers.${MCP_SERVER_NAME}.command=${toml(mcp.command)}`,
      // Hand-in tools must be ready before the first turn, including native resume.
      "-c", `mcp_servers.${MCP_SERVER_NAME}.required=true`,
      "-c",
      `mcp_servers.${MCP_SERVER_NAME}.args=${toml(mcp.args)}`,
      ...(options.mcp ? ["-c", `mcp_servers.${MCP_SERVER_NAME}.env_vars=${toml(Object.keys(ctx.decisionMcpEnv()))}`] : []),
      ...Object.entries(mcp.env).filter(([key]) => !key.startsWith("MIKKA_DECISION_MCP_")).flatMap(([key, value]) => [
        "-c",
        `mcp_servers.${MCP_SERVER_NAME}.env.${key}=${toml(value)}`,
      ]),
      ...(computerMcp ? [
        "-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.command=${toml(computerMcp.command)}`,
        "-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.args=${toml(computerMcp.args)}`,
        ...Object.entries(computerMcp.env).flatMap(([key, value]) => ["-c", `mcp_servers.${COMPUTER_MCP_SERVER_NAME}.env.${key}=${toml(value)}`]),
      ] : []),
      ...codexAppArgs(options.apps),
      ...credential.args,
      // Custom API-key and hosted-broker providers own their retry settings.
      // The reserved built-in OpenAI provider rejects overrides and keeps its
      // native finite retry loop; never replace official subscription auth.
      ...(credential.args.length ? [
        "-c", "model_providers.mikka.request_max_retries=2",
        "-c", "model_providers.mikka.stream_max_retries=2",
      ] : []),
      ...(brokerAuth ? [
        "-c", "model_providers.mikka.requires_openai_auth=false",
        "-c", "model_providers.mikka.supports_websockets=false",
      ] : []),
      ...(options.machineEnvironment ? ["-c", 'shell_environment_policy.inherit="all"', "-c", 'shell_environment_policy.ignore_default_excludes=true'] : []),
      // Personal devices retain their own run temp paths.
      ...Object.entries(ctx.tempEnv()).flatMap(([key, value]) => [
        "-c",
        `shell_environment_policy.set.${key}=${toml(value)}`,
      ]),
      ...(this.options.cliTiming?.args ?? []),
    ]
    const spawnOptions = {
      cwd: ctx.worktree,
      env: { ...options.env, ...(childPath ? { PATH: childPath } : {}), ...ctx.tempEnv(), ...ctx.decisionMcpEnv(), ...credential.env, CODEX_HOME: codexHome.home,
        ...this.options.cliTiming?.env },
      policy: ctx.policy(),
      pidFile: paths.pidFile,
      marker: ctx.runDir,
    }
    const adopted = mode === 'new' && externalAuth && options.machineEnvironment && !computerMcp && !options.apps?.apps.length &&
      this.options.anonymousCodexFresh ? await this.options.anonymousCodexCandidate?.adopt({
        fresh: this.options.anonymousCodexFresh, cwd: ctx.worktree, env: spawnOptions.env, binary, mcp, traceContext,
        repositoryRoot: options.gitWritePaths?.length === 1 ? options.gitWritePaths[0] : undefined,
        assertLive: () => { if (approval.revoked) throw Error('Run tool approval unavailable') },
        onRevoke: callback => approval.onRevoke(callback),
      }) : undefined
    if (adopted) nativeGenerations = adopted.nativeGenerations
    if (!adopted && daemonTracer.generationsEnabled && traceContext) {
      const bypass = codexTraceEnvironment(spawnOptions.env)
      if (!bypass) {
        nativeUnavailableReason = 'platform_proxy_unverified'
        void daemonTracer.span('daemon.ai.collection', { 'mikka.harness': 'codex', 'mikka.ai.native_unavailable_reason': nativeUnavailableReason },
          async () => {}, { traceContext }).catch(() => {})
      } else {
        try {
          nativeGenerations = await startCodexGenerationCollector(metrics => daemonTracer.generation(metrics, traceContext))
          argv.push(...nativeGenerations.args)
          Object.assign(spawnOptions.env, nativeGenerations.env, bypass)
        } catch (error) {
          nativeUnavailableReason = 'receiver_start_failed'
          void daemonTracer.span('daemon.ai.collection', { 'mikka.harness': 'codex', 'mikka.ai.rejected_batches': 1, 'mikka.ai.native_flush_confirmed': false,
            'mikka.ai.native_unavailable_reason': nativeUnavailableReason }, async span => { span.fail(error) }, { traceContext }).catch(() => {})
        }
      }
    }
    let child: Awaited<ReturnType<typeof spawnCli>>
    try { child = adopted?.child ?? await (this.options.spawnCli ?? spawnCli)(this.options.sandbox, argv, spawnOptions) }
    catch (error) { closeNativeGenerations(false); throw error }
    // Existing owned-child shutdown determines the deadline. The receiver
    // stays live through native exporter shutdown and drains in the background.
    void child.exited.then(() => closeNativeGenerations(true))
    // A revoked run gate stops the CLI (no sandbox launcher owns it any more).
    const off = options.toolApproval!.onRevoke(() => { void child.kill().catch(() => undefined) })
    void child.exited.finally(off)
    // After the whole group is gone (`exited` kills it first).
    void child.exited.then(() => { wipeRunCredentials(runDir) })
    const rpc: MessageConnection = adopted?.rpc ?? jsonlConnection(
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
    const sensitiveText = [firstMessage, options.prompt ?? "", options.continueSession?.message ?? "", options.credential?.key ?? "", options.apps?.token ?? ""]
    const capture = (error: unknown) => captureCodexRunFailure(error, { runId: options.runId, appVersion: DAEMON_VERSION, provider: "codex", credential: options.credential ? "api_key" : "subscription", sensitiveText })
    let failureDetails: RunFailure | undefined
    let lastError: string | undefined
    let lastFailure: CodexFailureInfo | undefined
    let providerFailure: ProviderFailure | undefined
    let turnStartFailure: string | undefined
    const subscriptionFailure = (phase: CodexFailurePhase, info: CodexFailureInfo) => {
      try { log.warn({ event: 'codex_subscription_turn_failed', phase, ...info }, 'Codex subscription turn failed') }
      catch { /* Diagnostics never replace the original terminal outcome. */ }
      return codexFailureMessage(phase, info)
    }
    /** The CLI's quota or rate-limit failure seen this turn, and the plan's latest windows. */
    let quota: QuotaSignal | undefined
    let rateLimits: CodexRateLimits | undefined
    let usage = { inputTokens: 0, outputTokens: 0 }
    const generations = new CodexGenerationMetrics(metrics => nativeGenerations
      ? nativeGenerations.collector.observeFallback(metrics, sessionId)
      : daemonTracer.generation({ ...metrics, nativeUnavailableReason }, traceContext))
    const pendingMcp = new Map<string,{turnId:string;server:string;tool:string;attempted:boolean}>()
    // Match the host-created MCP server's advertised capabilities. A fixed
    // check may inspect its artifact, but cannot select another repository.
    const handInTools = new Set(['submit', 'request_help', 'ask_human', 'report_blocked', 'submit_capture',
      ...(mcp.args.includes('--repository-selection') ? ['switch_repository'] : []),
      ...(mcp.args.includes('--factory-artifacts') ? ['inspect_artifact', 'inspect_repository'] : []),
      ...(mcp.args.includes('--factory-verify') ? ['verify_command'] : []),
    ])
    const registeredMcpTool = (server: string, tool: string) =>
      (server === MCP_SERVER_NAME && handInTools.has(tool)) ||
      (Boolean(computerMcp) && server === COMPUTER_MCP_SERVER_NAME && ['get_desktop_state','click','type_text','press_key','scroll'].includes(tool)) ||
      Boolean(options.apps?.apps.some(app => app.name === server))

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
      if (event) {
        const { failureDetails: supplied, ...terminal } = event
        queue.exit({ ...terminal, ...(event.outcome === "failed" && (supplied ?? failureDetails) ? { failureDetails: supplied ?? failureDetails } : {}) })
      }
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
        // Nothing is asked per tool (decision 2026-11-01-2335); the run must still be live.
        return await approval.checkLive() && !ending && !approval.revoked && call.turnId === activeTurn && pendingMcp.get(itemId) === item
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
          const auth = subscriptionTokens(await externalAuth.token(true), externalAuth.accountId)
          sensitiveText.push(auth.accessToken)
          options.onCredential?.("SUBSCRIPTION_ACCESS_TOKEN", auth.accessToken)
          return auth
        } catch (error) {
          void finish({ outcome: "failed", error: SUBSCRIPTION_AUTH_ERROR })
          throw new Error(SUBSCRIPTION_AUTH_ERROR, { cause: error })
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
        // Approvals are "never"; a request that still arrives goes ahead while the run is live.
        // Do not grant a session or policy amendment in place of one action.
        return { decision: await options.toolApproval.checkLive() && !options.toolApproval.revoked && !ending && call.turnId === activeTurn ? 'accept' : 'decline' }
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
        case 'item/commandExecution/outputDelta': {
          const progress = params as { threadId?: string; turnId?: string; delta?: string }
          if (progress.threadId === sessionId && progress.turnId === activeTurn && typeof progress.delta === 'string' && progress.delta.length > 0) queue.progress()
          return
        }
        case "item/agentMessage/delta": {
          const { itemId, delta } = params as DeltaNotification
          // An empty delta must not hide the completed item's full message.
          if (typeof delta !== "string" || delta.length === 0) return
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
          const notification = params as TokenUsageNotification
          if (notification.threadId !== sessionId) return
          const { total } = notification.tokenUsage
          generations.observe(notification.tokenUsage, runtimeModel)
          usage = {
            inputTokens: total.inputTokens,
            outputTokens: total.outputTokens,
          }
          return
        }
        case "account/rateLimits/updated":
          rateLimits = (params as RateLimitsNotification).rateLimits
          return
        case "error": {
          const { error, willRetry, threadId: errorThread } = params as ErrorNotification
          if (errorThread && errorThread !== sessionId) return
          if (!willRetry) quota = mergeQuota(quota, codexQuotaSignal(error, rateLimits))
          if (!willRetry) {
            failureDetails = capture(error)
            lastFailure = codexFailureInfo(error)
            providerFailure = codexProviderFailure(error)
            lastError = managedAuth
              ? subscriptionFailure('error_notification', lastFailure)
              : providerFailure ? providerFailureMessage(providerFailure) : `Codex: ${error.message}`
          }
          return
        }
        case "turn/completed":
          if ((params as TurnNotification).threadId !== sessionId) return
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
    if (!adopted) rpc.listen()

    const turnCompleted = async (turn: TurnNotification["turn"]) => {
      generations.endTurn()
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
      if (turn.status === "failed" || lastError) {
        if (turn.error) failureDetails = capture(turn.error)
        providerFailure = codexProviderFailure(turn.error) ?? providerFailure
        if (providerFailure) {
          quota = mergeQuota(quota, codexQuotaSignal(turn.error, rateLimits))
          const failure = codexFailureInfo(turn.error)
          return finish({
            outcome: "failed", providerFailure, ...(quota ? { quota } : {}),
            error: managedAuth
              ? subscriptionFailure('turn_completed', failure.category === 'unknown' && lastFailure ? lastFailure : failure)
              : providerFailureMessage(providerFailure),
          })
        }
      }
      const next = pending.shift()
      if (next) {
        await startTurn(next).catch((error: unknown) =>
          finish({
            outcome: "failed",
            error: managedAuth
              ? turnStartFailure ?? subscriptionFailure('turn_start', codexFailureInfo(error))
              : error instanceof ProviderFailureError ? error.message : `Codex: ${errorMessage(error)}`,
            ...(error instanceof ProviderFailureError ? { providerFailure: error.providerFailure } : {}),
          })
        )
        return
      }
      if (turn.status === "failed" || lastError) {
        quota = mergeQuota(quota, codexQuotaSignal(turn.error, rateLimits))
        const failure = codexFailureInfo(turn.error)
        return finish({
          outcome: "failed",
          ...(quota ? { quota } : {}),
          error: managedAuth
            ? subscriptionFailure('turn_completed', failure.category === 'unknown' && lastFailure ? lastFailure : failure)
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
      sensitiveText.push(message)
      failureDetails = undefined
      lastError = undefined
      lastFailure = undefined
      providerFailure = undefined
      turnStartFailure = undefined
      quota = undefined
      const verify = externalAuth?.verify ?? brokerAuth?.verify
      if (verify) {
        try { await daemonTracer.span("daemon.adapter.account_check", { "mikka.harness": "codex", "mikka.run.id_hash": runIdHash(options.runId) }, () => verify()) } catch (error) { throw new Error(SUBSCRIPTION_AUTH_ERROR, { cause: error }) }
      }
      generations.startTurn()
      const result = rpc.sendRequest<{ turn: { id: string } }>("turn/start", {
        threadId: sessionId,
        input: text(message),
        ...(options.effort ? { effort: options.effort } : {}),
      })
      const response = result.catch((error: unknown) => {
        failureDetails = capture(error)
        providerFailure = codexProviderFailure(error)
        if (managedAuth) turnStartFailure = subscriptionFailure('turn_start', codexFailureInfo(error))
        if (providerFailure) throw Object.assign(new ProviderFailureError(providerFailure), { failureDetails, cause: error })
        if (managedAuth) throw Object.assign(new Error(turnStartFailure, { cause: error }), { failureDetails })
        throw Object.assign(error instanceof Error ? error : new Error(errorMessage(error), { cause: error }), { failureDetails })
      })
      if (options.mailbox) {
        pendingTurnStart = response.then(({ turn }) => { if (!ending) activeTurn = turn.id })
        try { await pendingTurnStart } finally { pendingTurnStart = null }
      } else { const { turn } = await response; activeTurn ??= turn.id }
      runRuntimeTimings.agentAccepted(options.runId, 'codex_turn_start_ack')
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
        failureDetails: failureDetails ?? capture(new Error("codex_cli_exited_early")),
        ...(providerFailure ? { providerFailure } : {}),
        ...(quota ? { quota } : {}),
        error: managedAuth
          ? subscriptionFailure('child_exit', { category: 'cli_exited_early' })
          : providerFailure ? providerFailureMessage(providerFailure) : `codex app-server exited (${signal ?? code}): ${child.stderrTail() || "no output"}`
      })
    })

    const ready = <T,>(step: Promise<T>, label: string) =>
      untilReady(child, step, `codex ${label}`)
    let startupPhase: 'initialize' | 'oauth_login' | 'thread_start' | 'turn_start' = 'initialize'
    try {
      const traceAttributes = { "mikka.harness": "codex", "mikka.run.id_hash": runIdHash(options.runId) }
      const initialized = adopted?.initialized ?? await daemonTracer.span("daemon.adapter.cli_init", traceAttributes, () => ready(
        rpc.sendRequest<{ userAgent?: string }>("initialize", {
          clientInfo: {
            name: "mikka",
            title: "Mikka",
            version: DAEMON_VERSION,
          },
          capabilities: managedAuth || options.mailbox ? { experimentalApi: true } : null
        }),
        "initialize",
      ))
      if (!adopted) await rpc.sendNotification("initialized")
      const mailboxNativeVersion = codexMailboxResumeVersion(initialized.userAgent)
      if (mailboxCatalogue && mode !== 'new' && (!mailboxNativeVersion || mailboxNativeVersion !== mailboxResumeVersion))
        throw new Error('Run mailbox requires a verified original Codex thread')
      if (externalAuth) {
        startupPhase = 'oauth_login'
        try {
          const auth = subscriptionTokens(
            await daemonTracer.span("daemon.adapter.auth.token", traceAttributes, () => externalAuth.token(false)),
            externalAuth.accountId
          )
          sensitiveText.push(auth.accessToken)
          options.onCredential?.("SUBSCRIPTION_ACCESS_TOKEN", auth.accessToken)
          const loggedIn = await daemonTracer.span("daemon.adapter.account_check.login", traceAttributes, () => ready(
            rpc.sendRequest<{ type: string }>("account/login/start", {
              type: "chatgptAuthTokens",
              ...auth
            }),
            "subscription login"
          ))
          if (loggedIn.type !== "chatgptAuthTokens")
            throw new Error(SUBSCRIPTION_AUTH_ERROR)
        } catch (error) {
          throw new Error(SUBSCRIPTION_AUTH_ERROR, { cause: error })
        }
      }
      const thread: Omit<ThreadResumeParams, 'threadId'> = {
        cwd: ctx.worktree,
        ...(adopted ? { config: adopted.threadConfig } : {}),
        // Nothing is asked and Codex's own sandbox is off: the equivalent of
        // `--dangerously-bypass-approvals-and-sandbox` (decision 2026-11-01-2335).
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: ctx.instructions(),
        ...(options.model ? { model: options.model } : {}),
      }
      const newThread = () =>
        ready(
          rpc.sendRequest<ThreadResponse>("thread/start", { ...thread, ...(mailboxCatalogue ? { dynamicTools: mailboxCatalogue } : {}) }),
          "thread/start",
        )
      let response: ThreadResponse
      startupPhase = 'thread_start'
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
          if (managedAuth || mode !== "continue" || ending || options.requireSessionResume || options.mailbox) throw error
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
      if ((options.requireSessionResume || (options.mailbox && threadId)) && sessionId !== threadId)
        throw new Error("Codex resumed a different question thread")
      if (mailboxCatalogue && mailboxNativeVersion) recordCodexMailboxSession(this.options.stateDir, options.runId, codexHome.home, response.thread, mailboxCatalogue, mode !== 'new', mailboxNativeVersion)
      runtimeModel = typeof response.model === "string" && response.model ? response.model : null
      if (runtimeModel) options.onRuntimeModel?.(sessionId, runtimeModel)
      if(managedAuth)await this.options.onHostedSession?.(sessionId)
      startupPhase = 'turn_start'
      await ready(startTurn(firstMessage), "turn/start")
    } catch (error) {
      if (managedAuth) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        try { log.warn({ event: 'codex_subscription_startup_failed', phase: startupPhase,
          reason: typeof code === 'number' ? 'rpc_refused' : 'client_startup_failed',
          ...(typeof code === 'number' && Number.isInteger(code) && code >= -32768 && code <= -32000 ? { rpcCode: code } : {}) }, 'Subscription startup failed') } catch { /* Keep the original refusal. */ }
      }
      await finish(null)
      if (error instanceof ProviderFailureError) throw error
      if (managedAuth) throw new Error(turnStartFailure ?? SUBSCRIPTION_AUTH_ERROR, { cause: error })
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
        sensitiveText.push(message)
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

