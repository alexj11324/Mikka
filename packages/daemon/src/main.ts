import { coordinatorCapable } from "./coordinator/runner"
// Daemon boot, shared by every mode (ADR 0004): started by the desktop app,
// headless `mikka daemon`, and `tsx watch` in dev.
//
//   lock data dir -> secret -> journal / outbox / worktrees -> RPC socket
//   -> resume journaled runs -> loop: lease + watchdog check, then the
//      server link (register, allow-list refresh, heartbeat with run
//      progress and lease renewal, flush outbox, claim pinned runs, prune
//      worktrees)
//   -> commands loop: long-polls the server for messages people send the
//      device's running agents and for stop requests, and hands them to
//      the runs' sessions (ADR 0018)
import { randomBytes, randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs"
import { arch, hostname, platform } from "node:os"
import { classifySandboxFailure, type SandboxFailure } from "./sandbox-issue"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  COMMANDS_MAX_SKIP,
  COMMANDS_MAX_WAIT_SECONDS,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RPC_ERRORS,
  daemonRpc,
  FS_REQUESTS_MAX_WAIT_SECONDS,
  isTerminalRunState,
  type DaemonStatus,
  type Flavor,
  type FsResult,
  type Harness,
  type HarnessInfo,
  unknownQuotaReport,
  type RunCommand,
} from "@mikka/protocol"

import { ClaudeAdapter } from "./adapters/claude"
import { CodexAdapter } from "./adapters/codex"
import { CursorAdapter } from "./adapters/cursor"
import { MockAdapter } from "./adapters/mock"
import type { AgentAdapter } from "./adapters/types"
import { publishRun, snapshotTree } from "./agents/publish"
import { agentPublishedReceipt, githubReceiptEnvironment, withRunGitCredentials } from './agents/github-runtime'
import { runPaths } from "./agents/run-context"
import { CAPTURES_DIR, CaptureUploader } from "./captures"
import { runVerify } from "./agents/verify"
import { SandboxRuntime, type AgentSandbox } from "./agents/sandbox"
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { buildChildEnv } from "./env"
import { browseFolder, verifyExpectedOrigin } from "./fs-browse"
import {
  DaemonError,
  InvalidIdError,
  RunNotFoundError,
  ServerUnreachableError,
} from "./errors"
import { readJson, writeFileAtomic, writeJsonAtomic } from "./fs-util"
import { checkLatestVersion, type AutoUpdateRuntime } from "./auto-update"
import { restartService, uninstallService } from "./service"
import { detectDeviceType } from "./device-type"
import { detectHarnesses, deviceCapabilities, dockerAvailable, harnessFingerprint } from "./harnesses"
import { ensureHarness, type HarnessStore } from "./harness-install"
import { sweepRunCredentials } from "./agents/harness-home"
import { containerOwner, ensureRunnerImage, openRunContainer, selectIsolation, sweepRunContainers, type RunContainerOptions } from "./run-container"
import { createLocalSubscriptionRunner } from "./subscription-local-runner"
import { codexSupportsRunApproval } from "./adapters/codex-version"
import { ensureSandboxTools, missingSandboxTools } from "./sandbox-tools"
import { isSafeId } from "./ids"
import { acquireLock } from "./lock"
import { closeLogger, createLogger, type Logger } from "./log"
import { Outbox } from "./outbox"
import { QuotaPoller, type QuotaSource } from "./quota/poller"
import { DAEMON_VERSION, daemonPaths, type DaemonPaths } from "./paths"
import { decide, pushDecision, runPolicy } from "./permissions"
import { judgeComputerAction, noServerDecision } from "./decision-judgments"
import type { ServerDecide } from "./server-decision"
import { RpcServer, type RpcHandlers } from "./rpc/server"
import { RunJournal } from "./runs/journal"
import {
  baseReport,
  RunSupervisor,
  type SupervisorDeps,
} from "./runs/supervisor"
import type { DeviceRepo, MemoryServer, ServerLink } from "./server-link"
import { SessionRejectedError } from "./server-link-http"
import { WorktreeManager } from "./worktrees"
import { RepositoryCache } from "./repositories"
import { daemonTestMode, normalizeRepository } from "@mikka/protocol/repository"
import type { RunAssignment } from "./server-link"
import { createHostedBotRunner } from "./subscription-hosted-runner"
import { ComputerBroker } from "./computer/broker.mjs"
import { detectComputerDriver, executeDriver, type ComputerDriver } from "./computer/driver.mjs"
import { createHostedComputerExecutor, type CredentialExecutorAuthority } from "./computer/credential-executor"
import { pollWebComputerReviews } from "./computer/web-review"
import { localComputerMcp } from "./computer/local-grant.mjs"

export * from "./server-link"
export { DAEMON_VERSION, daemonPaths, defaultDataDir } from "./paths"

export interface DaemonOptions {
  dataDir: string
  /** Supplied only by the managed public npm CLI. */
  autoUpdate?: AutoUpdateRuntime
  flavor: Flavor
  link: ServerLink
  /** Set with `--server memory`: enables `dev.mockRun` (dev flavor only). */
  memoryServer?: MemoryServer
  /** Device credential; otherwise read from `device.json`. */
  credential?: string
  mockSpeed?: number
  fixturesDir?: string
  log?: Logger
  heartbeatMs?: number
  /** Watchdog limit without progress (default 10 minutes). */
  stallMs?: number
  /** Finished worktrees older than this are removed. */
  retentionMs?: number
  /** Keep acceptance worktrees, refs and failed clones for later inspection. */
  retainResources?: boolean
  /** Skip CLI detection (tests). */
  harnesses?: HarnessInfo[]
  /**
   * Subscription-quota reader. Omitted or `null`: no polling.
   */
  quotaSource?: QuotaSource | null
  /** Ignored when it is below the poller's minimum interval. */
  quotaPollMs?: number
  /**
   * Isolation for real agent CLIs; sandbox-runtime by default. Without a
   * sandbox (unsupported platform) only the mock harness is offered.
   */
  agentSandbox?: AgentSandbox | null
  /** Override a harness CLI binary (tests use fake CLIs). */
  harnessBinaries?: Partial<Record<"claude_code" | "codex" | "cursor", string>>
  /** Linux-only operator mode; no native/local credential source is opened. */
  hostedSubscriptions?: boolean
  /** Only the trusted E2B runner is allowed to select its isolated socket. */
  e2bContainerRuntime?: boolean
  /** Trusted infrastructure supplies its already-listening review broker. */
  computerBroker?: ComputerBroker
  /** Trusted E2B mode: create a guarded broker tied to the run journal. */
  cloudComputer?: boolean
  /** Trusted infrastructure only. Omit until the persistent action authority,
   * live target fence, and credential service are installed together. */
  credentialExecutorAuthority?: CredentialExecutorAuthority
  /** Long-poll wait for run commands, seconds (default 25; tests shorten). */
  commandsWaitSeconds?: number
  /** Called once the daemon stopped after `daemon.drain`. */
  onDrained?: () => void
  /**
   * Called once the daemon stopped because another process took its data
   * dir lock; the process should exit (the CLI exits 1).
   */
  onLockLost?: (error: Error) => void
}

/** Persisted in `device.json` (mode 0600). */
interface DeviceFile {
  completedDeviceCommands?: string[]
  failedDeviceCommands?: { id: string; error: string }[]
  credential?: string
  /**
   * This machine's one device id, the same in every workspace it joins
   * (ADR ORV-284). Kept across sign-outs and workspace switches.
   */
  deviceId?: string
  /** Set by `mikka daemon login --workspace` for multi-workspace users. */
  workspaceId?: string
  /** Last repository settings from the server; paths are logical keys locally. */
  repos?: DeviceRepo[]
}

/**
 * Reads `device.json`. Files from before ADR ORV-284 also hold `deviceIds`,
 * one id per workspace; the current id wins, else the first saved one, and
 * the map is dropped on the next save.
 */
export function loadDeviceFile(raw: unknown): DeviceFile {
  if (!raw || typeof raw !== "object") return {}
  const { deviceIds, ...file } = raw as DeviceFile & {
    deviceIds?: Record<string, unknown>
  }
  if (!file.deviceId && deviceIds && typeof deviceIds === "object") {
    const first = Object.values(deviceIds).find(
      (id): id is string => typeof id === "string"
    )
    if (first) file.deviceId = first
  }
  return file
}

const HARNESS_RESCAN_MS = 5 * 60_000

/** Whose model credential a cloud run uses: the subscription binding's owner, or for an API-key run the run owner the server assigned the computer to. */
function credentialOwner(assignment: RunAssignment): string | undefined {
  return assignment.subscriptionBinding?.ownerId ?? (assignment.modelCredential ? assignment.computer?.ownerId : undefined)
}
const SANDBOX_REPAIR_RETRY_MS = 60 * 60_000

/** A person may install a missing tool themselves; that alone is worth a new attempt. */
type SandboxIssue = { missing: string[] } & SandboxFailure

function missingToolsUnchanged(issue: SandboxIssue | null) {
  return !issue?.missing.length || missingSandboxTools().length === issue.missing.length
}

export class Daemon {
  readonly paths: DaemonPaths
  readonly log: Logger
  private releaseLock: (() => Promise<void>) | null = null
  private rpc: RpcServer | null = null
  private outbox!: Outbox
  private journal!: RunJournal
  private captureUploader!: CaptureUploader
  private worktrees!: WorktreeManager
  private repositories!: RepositoryCache
  supervisor!: RunSupervisor
  private device: DeviceFile = {}
  private harnesses: HarnessInfo[] = []
  private server: DaemonStatus["server"] = "unregistered"
  private timer: NodeJS.Timeout | null = null
  private tick: Promise<void> = Promise.resolve()
  private updating = false
  private claimsInFlight = 0
  private updateCheck: Promise<void> | null = null
  private maintenance: Promise<void> | null = null
  private updateVersion: string | undefined
  private draining = false
  private stopped = false
  private stopPromise: Promise<void> | null = null
  private starting: Promise<Daemon> | null = null
  private adapters = new Map<Harness, AgentAdapter>()
  /** Registered (or re-registered) with the server since this start. */
  private registered = false
  /** Run ids the server sent that were refused as unsafe (reported once). */
  private refusedRuns = new Set<string>()
  private quota: QuotaPoller | null = null
  /** Ends the commands long-poll when the daemon stops. */
  private commandsAbort = new AbortController()
  private commandsLoop: Promise<void> = Promise.resolve()
  private fsLoop: Promise<void> = Promise.resolve()
  private reviewAbort: AbortController | null = null
  private reviewLoop: Promise<void> = Promise.resolve()
  private cloudComputerBroker: ComputerBroker | null = null
  private localComputerDriver: ComputerDriver | null = null
  private localComputerBroker: ComputerBroker | null = null
  /** Messages handed to an agent whose delivery the server has not taken yet. */
  private unacked = new Set<string>()
  /** Runs this daemon already started cancelling for a stop request. */
  private stopping = new Set<string>()
  /** Runs this daemon has ended, whose end the server may not have yet. */
  private ended = new Set<string>()
  /** The server pass in flight; the next one starts after it. */
  private syncing: Promise<void> = Promise.resolve()
  /** Cuts the poll loop's pause short (the device just registered). */
  private wakeCommands: (() => void) | null = null

  constructor(private readonly options: DaemonOptions) {
    this.paths = daemonPaths(options.dataDir)
    this.log = options.log ?? createLogger({ dir: this.paths.logs })
  }

  async start() {
    this.starting = this.startInternal()
    try {
      return await this.starting
    } catch (error) {
      await this.stop().catch((err: unknown) => {
        this.log.warn({ err }, "daemon startup cleanup failed")
      })
      throw error
    }
  }

  private async startInternal() {
    const { paths } = this
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 })
    // `mode` only applies on creation; tighten a dir that already existed.
    if (process.platform !== "win32") chmodSync(paths.dataDir, 0o700)
    this.releaseLock = await acquireLock(
      paths.dataDir,
      paths.lock,
      (error) => this.onLockCompromised(error),
      { socketPath: paths.socket }
    )
    if (this.stopped) throw new Error("daemon stopped during startup")
    const secret = this.ensureSecret()
    this.device = loadDeviceFile(readJson(paths.device))
    if (this.options.credential)
      this.saveDevice({ credential: this.options.credential })

    this.journal = new RunJournal(paths.journal)
    this.captureUploader = new CaptureUploader((runId) => join(runPaths(paths.adapterState, runId).runDir, CAPTURES_DIR), this.options.link, this.log, join(paths.dataDir, "capture-pending"))
    this.outbox = new Outbox(
      paths.outbox,
      this.options.link,
      this.log,
      undefined,
      (runId, _item, error) => this.supervisor.markUndeliverable(runId, error),
      this.options.retainResources
    )
    this.worktrees = new WorktreeManager(paths.worktrees, this.options.retainResources)
    this.repositories = new RepositoryCache(paths.repos, undefined, this.options.retainResources)
    // Hosted subscriptions use their dedicated container sandbox. Local
    // adapters require the separately probed sandbox-runtime from main.
    this.sandbox = this.options.hostedSubscriptions ? null : await this.createAgentSandbox()
    if (this.stopped) throw new Error("daemon stopped during startup")
    if (!this.options.hostedSubscriptions && this.sandbox) this.localComputerDriver = await detectComputerDriver()
    if (this.localComputerDriver && this.options.link.syncComputerReviews && this.options.link.localComputerAuthority) {
      this.localComputerBroker = new ComputerBroker({
        driver: this.localComputerDriver,
        socketPath: join(paths.dataDir, 'local-computer.sock'),
        transport: 'tcp',
        needsPerson: this.computerNeedsPerson(),
        permitted: runId => {
          const assignment = this.journal.get(runId)?.assignment
          return Boolean(!this.stopped && this.registered && assignment?.localComputer && !assignment.computer &&
            assignment.deviceId === this.device.deviceId && assignment.policy?.permissions.computer_use &&
            decide('computer_use', { policy: assignment.policy }) !== 'deny' && this.supervisor?.computerRunAllowed(runId))
        },
        execute: async (driver, call, display, runId, context) => {
          const initial = this.journal.get(runId)?.assignment.localComputer
          if (!initial || display !== undefined) throw new Error('Local computer unavailable')
          const recheck = async () => {
            const current = await this.options.link.localComputerAuthority!(this.device.deviceId!, runId)
            context.assertLive()
            if (current.botId !== initial.botId || current.ownerId !== initial.ownerId || current.workspaceId !== initial.workspaceId || current.policyVersion !== initial.policyVersion || current.permission !== initial.permission)
              throw new Error('Local computer authority changed')
          }
          try {
            await recheck()
            return await executeDriver(driver, call, undefined, undefined, context.assertLive, recheck)
          } catch (error) {
            this.localComputerBroker?.spec(runId, 'deny')
            throw error
          }
        },
      })
      await this.localComputerBroker.listen()
    }
    if (this.options.cloudComputer) {
      if (!this.options.hostedSubscriptions || !this.options.e2bContainerRuntime || this.options.computerBroker) throw new Error("Cloud computer runtime unavailable")
      const driver = await detectComputerDriver('/opt/mikka/computer/cua-driver')
      if (!driver) throw new Error("Cloud computer driver unavailable")
      const liveComputer = (runId: string, display: string | undefined) => {
        const entry = this.journal.get(runId)
        const computer = entry?.assignment.computer
        if (this.stopped || !this.registered || !computer || computer.display !== display || !entry || computer.ownerId !== credentialOwner(entry.assignment) || !this.supervisor.computerRunAllowed(runId)) throw new Error('Cloud computer run unavailable')
        return computer
      }
      const executeOrdinary = async (current: typeof driver, call: import('./computer/driver.mjs').ComputerCall, display: string | undefined, runId: string, assertLive: () => void) => {
        const computer = liveComputer(runId, display)
        return executeDriver(current, call, display, { botId: computer.botId, ownerId: computer.ownerId, policyVersion: computer.policyVersion }, assertLive)
      }
      this.cloudComputerBroker = new ComputerBroker({ driver, socketPath: join(paths.dataDir, 'computer.sock'),
        needsPerson: this.computerNeedsPerson(),
        permitted: runId => {
          const entry = this.journal.get(runId)
          return Boolean(!this.stopped && this.registered && entry?.assignment.computer && this.supervisor?.computerRunAllowed(runId))
        },
        execute: createHostedComputerExecutor({ liveComputer, executeOrdinary, authority: this.options.credentialExecutorAuthority }),
        // The server picks the desktop from the run's binding; the call names none.
        capture: async (runId, call, signal) => {
          const entry = this.journal.get(runId)
          if (!entry?.assignment.computer || !this.supervisor.computerRunAllowed(runId) || !this.options.link.screenCapture) throw new Error('Cloud computer run unavailable')
          try {
            return await this.options.link.screenCapture(runId, call, signal)
          } catch (error) {
            // A refusal carries the server's own fixed wording (a recording already going, the person holds the desktop).
            const detail = error instanceof DaemonError && typeof (error.data as { error?: unknown } | undefined)?.error === 'string' ? (error.data as { error: string }).error : undefined
            throw Object.assign(new Error('Capture failed'), detail ? { safeMessage: detail } : {})
          }
        },
      })
    }
    // Docker decides the run isolation (run-container.ts), so probe it before the adapters exist.
    // Tests drive fake CLIs on the host.
    if (!this.options.hostedSubscriptions && !this.options.harnesses && !this.options.harnessBinaries && !daemonTestMode(process.env)) {
      this.docker = await dockerAvailable()
      if (this.docker) await sweepRunContainers(containerOwner(paths.dataDir)).catch(() => undefined)
    }
    const hosted = this.options.hostedSubscriptions
      ? await createHostedBotRunner({
          stateDir: paths.adapterState,
          link: this.options.link,
          binaries: this.options.harnessBinaries,
          ...(this.options.e2bContainerRuntime ? { dockerSocket: "unix:///run/mikka-container/docker.sock" as const } : {}),
          computerBroker: this.cloudComputerBroker ?? this.options.computerBroker,
        })
      : undefined
    await this.cloudComputerBroker?.listen()
    if (this.stopped) throw new Error("daemon stopped during startup")
    const adapters = (this.adapters = new Map<Harness, AgentAdapter>([
      ...(daemonTestMode(process.env) ? [[
        "mock",
        new MockAdapter({
          stateDir: paths.adapterState,
          fixturesDir: this.options.fixturesDir,
          speed: this.options.mockSpeed,
        }),
      ] as [Harness, AgentAdapter]] : []),
      ...(hosted
        ? hosted.harnesses.map(
            (harness) =>
              [
                harness,
                {
                  harness,
                  capabilities: {
                    supportsInterject: true,
                    supportsResume: false,
                  },
                  envAllow: [],
                  async start() {
                    throw new Error("subscription_binding_required")
                  },
                  async resume() {
                    throw new Error("subscription_binding_required")
                  },
                },
              ] as [Harness, AgentAdapter]
          )
        : this.realAdapters()),
    ]))
    this.supervisor = new RunSupervisor({
      journal: this.journal,
      adapterStateDir: this.paths.adapterState,
      outbox: this.outbox,
      worktrees: this.worktrees,
      adapters,
      startSubscription: hosted?.start ?? this.localSubscriptions()?.start,
      startCredential: hosted?.start,
      prepareRunMailbox: this.options.link.prepareRunMailbox?.bind(this.options.link),
      prepareRunToolApproval: this.options.link.prepareRunToolApproval?.bind(this.options.link),
      verifyRunPolicy: this.options.link.verifyRunPolicy ? async (assignment,signal) => {
        // resumeAll runs before the first sync; establish the existing device
        // session before fetching the independent signing context.
        if (!this.device.credential) throw new Error('Current policy device credential unavailable')
        if (!this.registered || !this.device.deviceId) await this.register(this.device.credential)
        return this.options.link.verifyRunPolicy!(assignment,signal)
      } : undefined,
      bootstrap: hosted
        ? async (worktree, repo) => {
            if (
              repo.setup?.copyFiles.some((path) =>
                /(^|\/)(\.git|\.codex\/auth\.json|\.claude\/\.credentials\.json)(\/|$)/.test(
                  path
                )
              )
            )
              throw new Error("native_credential_import_refused")
            const result = await this.worktrees.bootstrap(
              worktree,
              repo.path,
              repo.setup ? { ...repo.setup, command: undefined } : undefined
            )
            if (repo.setup?.approved && repo.setup.command) {
              const checked = await hosted.command(
                worktree,
                repo.setup.command,
                false,
                30 * 60_000
              )
              if (checked.exitCode !== 0) throw new Error("hosted_setup_failed")
            }
            return result
          }
        : undefined,
      repository: assignment => this.repository(assignment),
      prepareRepository: async (assignment, signal) => {
        if (assignment.remoteUrl) await withRunGitCredentials(assignment, runPaths(this.paths.adapterState, assignment.runId).privateDir,
          env => this.repositories.prepare(assignment.remoteUrl!, signal, env))
      },
      baseRef: assignment => assignment.remoteUrl
        ? this.repositories.baseRef(assignment.remoteUrl, assignment.baseBranch)
        : Promise.resolve(assignment.baseBranch ?? 'HEAD'),
      log: this.log,
      captures: this.captureUploader,
      stallMs: this.options.stallMs,
      revalidateSkillAssignment:async assignment=>{
        const link=this.options.link
        if (!assignment.skillReceipt||!link.validateSkillReceipt||!this.device.credential) throw new Error('Current Skill receipt validation unavailable')
        if (!this.registered||!this.device.deviceId) await this.register(this.device.credential)
        return link.validateSkillReceipt(assignment.runId,assignment.skillReceipt.id)
      },
      verify: hosted
        ? (run) =>
            hosted.command(
              run.worktree,
              run.command,
              run.readOnly,
              run.timeoutMs,
              run.signal
            )
        : this.verifier(),
      publisher: {
        snapshot: ({ worktree, repo }) => snapshotTree(repo.path, worktree),
        publish: async ({ runId, worktree, repo, assignment, report, tree }) =>
          assignment.github && assignment.mcp ? agentPublishedReceipt({
            runId, repoPath: repo.path, worktree, tree,
            github: { ...assignment.github, runToken: assignment.mcp.token, issueId: assignment.issueId },
            privateDir: join(paths.adapterState, 'pids'),
            ...(hosted ? { hosted: true } : {}),
            env: githubReceiptEnvironment(),
          }) : publishRun({
            runId,
            repoPath: repo.path,
            worktree,
            tree,
            issueId: assignment.issueId,
            summary: report.summary,
            pushBranch: assignment.pushBranch,
            baseBranch: assignment.remoteUrl ? await this.repositories.baseRef(assignment.remoteUrl, assignment.baseBranch) : assignment.baseBranch,
            push: (() => {
              const decision = pushDecision(runPolicy(assignment.policy))
              return {
                approved: decision.push,
                remote: repo.push?.remote ?? "origin",
                note: decision.note,
              }
            })(),
          }),
      },
    })

    this.rpc = new RpcServer({
      socketPath: paths.socket,
      secret,
      hello: () => ({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        daemonVersion: DAEMON_VERSION,
        pid: process.pid,
      }),
      handlers: this.handlers(),
      log: this.log,
    })
    await this.rpc.listen()
    if (this.stopped) throw new Error("daemon stopped during startup")

    // Only harnesses this daemon can drive are advertised: the server must
    // never pin a run here that no adapter would take. (A detected CLI
    // without an adapter yet is left out; the schema has no "unsupported".)
    const detected = hosted
      ? hosted.harnesses.map((harness) => ({ harness, installed: true, version: null, subscriptionBroker: true as const, ...(this.cloudComputerBroker ? { computerBroker: true as const } : {}) }))
      : (this.options.harnesses ?? detectHarnesses(this.harnessStore()))
    if (this.stopped) throw new Error("daemon stopped during startup")
    // A callback alone is insufficient: the host must own the enforcement
    // boundary and bind its lifetime to the run's authenticated gate.
    if (!hosted && !this.options.harnesses) this.harnessPrint = harnessFingerprint(this.harnessStore())
    this.harnesses = [...detected.filter((info) => this.adapters.has(info.harness)).map(info => ({
      ...info,
      // Local enforcement requires the successful owned SRT probe. Hosted
      // enforcement uses its existing network-none/read-only Docker boundary
      // and gate-bound broker/container teardown; general egress stays outside
      // that ceiling. Codex also verifies its pinned interface at initialize.
      toolApproval: this.supportsToolApproval(info),
      coordinator: hosted ? false : coordinatorCapable(info),
      ...(!hosted && this.localSubscriptionCapable(info) ? { subscriptionBroker: true as const } : {}),
    })), ...this.sandboxBlockedHarnesses(detected)]
    // A crash or kill skipped the run-end wipe; resumed runs get fresh credentials.
    sweepRunCredentials(paths.adapterState)
    // Runs survive restarts: pick up what the journal says was active.
    await this.supervisor.resumeAll()
    // The person's own logins are never read (devices are runners), so only
    // an injected source polls.
    if (!hosted && this.options.quotaSource) {
      this.quota = new QuotaPoller(
        this.options.quotaSource,
        { log: this.log, intervalMs: this.options.quotaPollMs }
      )
      this.quota.start()
    }
    this.log.info(
      {
        data_dir: paths.dataDir,
        flavor: this.options.flavor,
        version: DAEMON_VERSION,
      },
      "daemon started"
    )
    this.schedule(0)
    this.commandsLoop = this.pollCommands()
    this.fsLoop = this.pollFolderRequests()
    return this
  }

  /**
   * Long-polls the server for messages and stop requests for this device's
   * runs (ADR 0018). Delivery is at least once: a message is acked after
   * its session took it, so a crash in between hands it over again.
   */
  private async pollCommands() {
    const { link } = this.options
    const signal = this.commandsAbort.signal
    const wait = this.options.commandsWaitSeconds ?? COMMANDS_MAX_WAIT_SECONDS
    let backoff = 1_000
    while (!this.stopped) {
      const deviceId = this.device.deviceId
      const credential = this.device.credential
      try {
        if (!this.registered || !deviceId) {
          await this.pauseCommands(1_000, signal)
          continue
        }
        if (this.unacked.size > 0) {
          const ids = [...this.unacked]
          await link.ackCommands(deviceId, ids)
          for (const id of ids) this.unacked.delete(id)
        }
        // Runs being stopped or already ended would come back on every
        // answer; leaving them out lets the poll wait for new commands.
        const skipRuns = [...this.stopping, ...this.ended].slice(
          0,
          COMMANDS_MAX_SKIP
        )
        const started = performance.now()
        const commands = await link.fetchCommands(deviceId, wait, {
          signal,
          skipRuns,
        })
        if (this.stopped || signal.aborted) return
        backoff = 1_000
        const acted = await this.applyCommands(commands)
        if (this.unacked.size > 0) continue // ack right away
        if (commands.length === 0 && !signal.aborted) {
          const remaining = Math.max(1_000, wait * 1_000) - (performance.now() - started)
          if (remaining > 0) await this.pauseCommands(remaining, signal)
        }
        // A message for a run with no session yet (still preparing): retry
        // shortly instead of spinning on the same answer.
        if (commands.length > 0 && !acted) await this.pauseCommands(500, signal)
      } catch (error) {
        if (this.stopped || signal.aborted) return
        if (error instanceof SessionRejectedError) this.rejectDeviceSession(credential)
        if (!(error instanceof ServerUnreachableError))
          this.log.warn({ err: error }, "fetching run commands failed")
        await this.pauseCommands(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  /**
   * Answers the app's folder requests for the repository picker (ADR 0037):
   * a second long-poll next to the run commands, so a slow folder never
   * delays a stop.
   */
  private async pollFolderRequests() {
    const { link } = this.options
    if (!link.fetchFsRequests || !link.answerFsRequest) return
    const signal = this.commandsAbort.signal
    const wait = this.options.commandsWaitSeconds ?? FS_REQUESTS_MAX_WAIT_SECONDS
    let backoff = 1_000
    while (!this.stopped) {
      const deviceId = this.device.deviceId
      const credential = this.device.credential
      try {
        if (!this.registered || !deviceId) {
          await this.pauseCommands(1_000, signal)
          continue
        }
        const started = performance.now()
        const requests = await link.fetchFsRequests(
          deviceId,
          wait,
          { signal }
        )
        if (this.stopped || signal.aborted) return
        backoff = 1_000
        // Some servers return an empty queue without honoring the long-poll wait.
        if (requests.length === 0 && !signal.aborted) {
          const remaining = Math.max(1_000, wait * 1_000) - (performance.now() - started)
          if (remaining > 0) await this.pauseCommands(remaining, signal)
        }
        await Promise.all(
          requests.map(async ({ id, ...request }) => {
            const result = await browseFolder(request).catch((): FsResult => ({
              ok: false,
              code: "failed",
              message: "Could not read that folder.",
            }))
            await link.answerFsRequest!(deviceId, id, result)
          })
        )
      } catch (error) {
        if (this.stopped || signal.aborted) return
        if (error instanceof SessionRejectedError) this.rejectDeviceSession(credential)
        if (!(error instanceof ServerUnreachableError))
          this.log.warn({ err: error }, "answering folder requests failed")
        await this.pauseCommands(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  /** Waits `ms`, or less if the daemon stops or the device registers. */
  private pauseCommands(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", done)
        this.wakeCommands = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener("abort", done, { once: true })
      this.wakeCommands = done
    })
  }

  /** Hands commands to the runs' sessions; true when any took effect. */
  private async applyCommands(commands: RunCommand[]): Promise<boolean> {
    let acted = false
    for (const command of commands) {
      const entry = this.journal.get(command.runId)
      // Not a run of this daemon (yet), or one that already ended.
      if (!entry) continue
      if (isTerminalRunState(entry.state)) {
        // The server cancelled a run this daemon had parked on a question:
        // nothing runs there, so its leftovers can go.
        if (command.kind === "stop")
          void this.supervisor.discardIfEmpty(command.runId, command.runId)
        this.ended.add(command.runId)
        // Only the latest matter: the server soon has their end too.
        for (const old of this.ended) {
          if (this.ended.size <= COMMANDS_MAX_SKIP / 2) break
          this.ended.delete(old)
        }
        continue
      }
      if (command.kind === "stop") {
        if (this.stopping.has(command.runId)) continue
        this.stopping.add(command.runId)
        acted = true
        this.log.info({ run_id: command.runId }, "stop requested; cancelling")
        void this.supervisor
          .cancel(command.runId)
          .catch((err: unknown) =>
            this.log.warn({ run_id: command.runId, err }, "cancel failed")
          )
          .finally(() => this.stopping.delete(command.runId))
        continue
      }
      if (this.unacked.has(command.messageId)) continue
      try {
        await this.supervisor.send(command.runId, command.text)
        this.unacked.add(command.messageId)
        acted = true
        this.log.info(
          { run_id: command.runId, message_id: command.messageId },
          "message handed to the agent"
        )
      } catch (error) {
        // No session yet (still preparing): it comes back on the next poll.
        if (!(error instanceof RunNotFoundError))
          this.log.warn(
            { run_id: command.runId, err: error },
            "could not hand the message to the agent"
          )
      }
    }
    return acted
  }

  private supportsToolApproval(info: HarnessInfo): true | undefined {
    // A callback alone is insufficient: the host must own the enforcement
    // boundary and bind its lifetime to the run's authenticated gate.
    if (typeof this.options.link.prepareRunToolApproval !== 'function') return undefined
    if (this.options.hostedSubscriptions) return true
    if (this.ownedSandbox === null || this.sandbox !== this.ownedSandbox) return undefined
    return info.harness === 'claude_code' || (info.harness === 'codex' && codexSupportsRunApproval(info.version)) ? true : undefined
  }

  /** A subscription run here takes a per-run access lease (subscription-local-runner.ts). */
  private localSubscriptionCapable(info: HarnessInfo) {
    return (info.harness === "claude_code" || info.harness === "codex") && info.installed &&
      this.supportsToolApproval(info) === true && Boolean(this.options.link.nativeLease)
  }

  /** Report a CLI the daemon cannot run as present but not installed, so no run is pinned here. */
  private sandboxBlockedHarnesses(detected: HarnessInfo[]): HarnessInfo[] {
    const issue = this.sandboxIssue
    if (!issue) return []
    return detected.filter(info => info.installed && !this.adapters.has(info.harness)).map(info => ({
      harness: info.harness, installed: false, version: info.version,
      sandboxBlocked: { missing: issue.missing, ...(issue.reason ? { reason: issue.reason } : {}), ...(issue.detail ? { detail: issue.detail } : {}) },
    }))
  }

  private async redetectHarnesses() {
    const repairing = this.sandboxIssue?.missing.length
    if (this.sandboxIssue && repairing) {
      this.lastSandboxRepair = Date.now()
      this.sandboxIssue = { missing: await ensureSandboxTools({ dataDir: this.paths.dataDir, log: this.log }) }
    }
    const detected = detectHarnesses(this.harnessStore())
    this.harnessPrint = harnessFingerprint(this.harnessStore())
    this.docker = await dockerAvailable()
    this.harnesses = [...detected.filter(info => this.adapters.has(info.harness)).map(info => {
      return { ...info, toolApproval: this.supportsToolApproval(info), coordinator: coordinatorCapable(info),
        ...(this.localSubscriptionCapable(info) ? { subscriptionBroker: true as const } : {}) }
    }), ...this.sandboxBlockedHarnesses(detected)]
    // Adapters and verification are wired at startup, so a repaired sandbox needs a fresh start.
    if (repairing && this.sandboxIssue?.missing.length === 0) {
      this.startMaintenance(() => restartService(false, () => {}, undefined, () => !this.stopped))
    }
  }

  /** Notice an agent installed after startup, or retry a failed tool download, without spawning anything per tick. */
  private rescanHarnesses() {
    const now = Date.now()
    if (this.options.hostedSubscriptions || this.options.harnesses || this.rescanning || now - this.lastHarnessScan < HARNESS_RESCAN_MS) return
    this.lastHarnessScan = now
    const retryRepair = Boolean(this.sandboxIssue?.missing.length) && now - this.lastSandboxRepair >= SANDBOX_REPAIR_RETRY_MS
    if (harnessFingerprint(this.harnessStore()) === this.harnessPrint && !retryRepair && missingToolsUnchanged(this.sandboxIssue)) return
    this.rescanning = true
    void this.redetectHarnesses()
      .then(() => this.syncWithServer())
      .catch((err: unknown) => { this.log.warn({ err }, "harness rescan failed") })
      .finally(() => { this.rescanning = false })
  }

  private harnessPrint = ""
  private docker = false

  /** The daemon's own pinned harnesses (harness-install.ts). */
  private harnessStore(): HarnessStore {
    return { root: this.paths.harness }
  }

  /** What this machine can run; Docker is probed at startup and on redetect. */
  private async runnerReport() {
    if (this.options.hostedSubscriptions) return undefined
    return deviceCapabilities(this.harnessStore(), this.paths.dataDir, async () => this.docker)
  }
  private lastHarnessScan = Date.now()
  private lastSandboxRepair = Date.now()
  private rescanning = false
  private sandboxIssue: SandboxIssue | null = null
  private sandbox: AgentSandbox | null = null
  private ownedSandbox: SandboxRuntime | null = null

  /** The agent sandbox (one per daemon), or null where there is none. */
  private agentSandbox(): AgentSandbox | null {
    return this.sandbox
  }

  private async createAgentSandbox(): Promise<AgentSandbox | null> {
    if (this.options.agentSandbox !== undefined) return this.options.agentSandbox
    // Tests use the host's tools as they are; fetching them with apt would
    // make every test daemon's start depend on the network.
    const missing = daemonTestMode(process.env)
      ? missingSandboxTools()
      : await ensureSandboxTools({ dataDir: this.paths.dataDir, log: this.log })
    if (!SandboxRuntime.supported()) {
      this.log.warn({ missing }, "agent sandbox unavailable: platform or dependencies unsupported")
      this.sandboxIssue = { missing }
      return null
    }
    const sandbox = new SandboxRuntime(async ({ host }) => {
      this.log.warn({ host }, "agent network request denied")
      return false
    })
    try {
      if (process.platform === 'linux') {
        const dependencies = SandboxManager.checkDependencies()
        if (dependencies.warnings.length) throw new Error(`Run sandbox isolation unavailable: ${dependencies.warnings.join('; ')}`)
      }
      await sandbox.probe()
      this.ownedSandbox = sandbox
      return sandbox
    } catch (err) {
      this.log.warn({ err }, "agent sandbox unavailable")
      // The device page says why and what the person can do (sandbox-issue.ts).
      this.sandboxIssue = { missing: [], ...classifySandboxFailure(err) }
      if (!this.options.retainResources) await sandbox.reset().catch((resetError: unknown) => {
        this.log.warn({ err: resetError }, "agent sandbox cleanup failed")
      })
      return null
    }
  }

  /** Verify inside the agent's sandbox; without one, only mock runs exist. */
  private verifier(): SupervisorDeps["verify"] {
    const sandbox = this.agentSandbox()
    if (!sandbox) return undefined
    return ({
      runId,
      worktree,
      repo,
      command,
      timeoutMs,
      signal,
      readOnly,
    }) => {
      const paths = runPaths(this.paths.adapterState, runId)
      return runVerify(sandbox, {
        command,
        worktree: realpathSync(worktree),
        tmpRoot: join(this.paths.adapterState, "verify", runId),
        privateDir: paths.privateDir,
        pidFile: paths.pidFile.replace(/\.pgid$/, ".verify.pgid"),
        networkAllow: repo.networkAllow,
        env: { ...buildChildEnv(), MIKKA_HANDOFF_FILE: join(paths.runDir, "handoff.json") },
        timeoutMs,
        signal,
        readOnly,
      })
    }
  }

  /**
   * Claude Code and Codex enclose the whole CLI in a run-owned official
   * sandbox. Cursor retains the existing daemon AgentSandbox boundary.
   */
  private realAdapters(): [Harness, AgentAdapter][] {
    const options = this.adapterOptions()
    if (!options) return []
    return [
      ["claude_code", new ClaudeAdapter(options.claude)],
      ["codex", new CodexAdapter(options.codex)],
      ["cursor", new CursorAdapter(options.cursor)],
    ]
  }

  /** The server's Decisions API for this daemon's runs; no answer until the link provides one. */
  private serverDecide(): ServerDecide {
    const link = this.options.link
    return link.decide ? link.decide.bind(link) : noServerDecision
  }

  /** Under computer `ask`: whether one action needs the person, judged with the run's task. */
  private computerNeedsPerson() {
    return (runId: string, evidence: { call: unknown; recent: string[] }, signal?: AbortSignal) =>
      judgeComputerAction(this.serverDecide(), runId, { ...evidence, task: this.journal.get(runId)?.assignment.prompt }, signal)
  }

  /** What every real adapter of this daemon is built with, subscription runs included. */
  private adapterOptions() {
    const sandbox = this.agentSandbox()
    if (!sandbox) return undefined
    const stateDir = this.paths.adapterState
    const bin = this.options.harnessBinaries ?? {}
    const openContainer = selectIsolation(process.platform, this.docker)
      === "container" ? async (run: Omit<RunContainerOptions, "image" | "owner">) =>
        openRunContainer({ ...run, image: await ensureRunnerImage(), owner: containerOwner(this.paths.dataDir) })
      : undefined
    const computerProvider = (runId: string) => {
      const assignment = this.journal.get(runId)?.assignment
      if (!assignment?.localComputer || assignment.computer || !assignment.policy?.permissions.computer_use) return undefined
      return localComputerMcp({ broker: this.localComputerBroker, runId,
        permission: decide('computer_use', { policy: assignment.policy }), readOnly: assignment.policy.readOnly,
        proxyPath: fileURLToPath(new URL('./computer/proxy.mjs', import.meta.url)), nodeBinary: process.execPath })
    }
    return {
      claude: { sandbox, stateDir, binary: bin.claude_code, ensureBinary: () => ensureHarness(this.harnessStore(), "claude_code"), openContainer, computerProvider },
      codex: { sandbox, stateDir, binary: bin.codex, ensureBinary: () => ensureHarness(this.harnessStore(), "codex"), openContainer, computerProvider },
      cursor: { sandbox, stateDir, binary: bin.cursor, computerProvider, decide: this.serverDecide() },
    }
  }

  /**
   * Subscription runs on this device: the server hands each run its
   * short-lived access token, never the refresh grant (subscription-local-runner.ts).
   */
  private localSubscriptions() {
    const link = this.options.link
    const options = this.adapterOptions()
    if (!options || !link.nativeLease) return undefined
    return createLocalSubscriptionRunner({
      stateDir: this.paths.adapterState,
      link: { nativeLease: link.nativeLease.bind(link) },
      claude: options.claude,
      codex: options.codex,
    })
  }

  private revokeLocalComputerGrants() {
    if (!this.localComputerBroker) return
    for (const entry of this.journal.all()) this.localComputerBroker.spec(entry.assignment.runId, 'deny')
  }

  /** Another process took the data dir: stop runs (journaled) and exit. */
  private onLockCompromised(error: Error) {
    this.log.error({ err: error }, "daemon lock compromised; stopping")
    this.releaseLock = null
    void this.stop().finally(() => this.options.onLockLost?.(error))
  }

  private ensureSecret(): string {
    if (existsSync(this.paths.secret)) {
      return readFileSync(this.paths.secret, "utf8").trim()
    }
    const secret = randomBytes(32).toString("hex")
    writeFileAtomic(this.paths.secret, `${secret}\n`)
    return secret
  }

  private saveDevice(patch: Partial<DeviceFile>) {
    this.device = { ...this.device, ...patch }
    writeJsonAtomic(this.paths.device, this.device)
  }

  private schedule(delay: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      // Runs past their lease or watchdog limit stop even while offline.
      this.supervisor.check()
      this.tick = this.syncWithServer().finally(() =>
        this.schedule(this.options.heartbeatMs ?? 15_000)
      )
    }, delay)
    this.timer.unref()
  }

  private async register(credential: string) {
    const { workspaceId, deviceId: knownDeviceId } = this.device
    const { deviceId } = await this.options.link.registerDevice(
      credential,
      {
        name: hostname(),
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        daemonVersion: DAEMON_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        deviceType: process.env.MIKKA_DEVICE_TYPE === "server" ? "server" : process.env.MIKKA_DEVICE_TYPE === "laptop" ? "laptop" : await detectDeviceType(),
        harnesses: this.harnesses,
        computerUse: { installed: Boolean(this.localComputerDriver), version: this.localComputerDriver?.version ?? null },
        runner: await this.runnerReport(),
        ...(workspaceId
          ? { workspaceId }
          : {}),
      },
      knownDeviceId
    )
    // A late registration must not restore the session replaced over RPC.
    if (this.device.credential !== credential || this.device.workspaceId !== workspaceId) throw new Error('Device session changed during registration')
    if (deviceId !== this.device.deviceId) {
      this.saveDevice({ deviceId })
      this.log.info({ device_id: deviceId }, "device registered")
    }
    const computerBroker = this.localComputerBroker ?? this.cloudComputerBroker ?? this.options.computerBroker
    if (computerBroker && !this.options.link.syncComputerReviews) throw new Error("Computer review transport unavailable")
    this.registered = true
    if (computerBroker && !this.stopped) {
      this.reviewAbort?.abort()
      const abort = new AbortController()
      this.reviewAbort = abort
      this.reviewLoop = pollWebComputerReviews(computerBroker, deviceId, this.options.link, abort.signal)
    }
    this.wakeCommands?.()
  }

  /**
   * One pass of the server link loop; safe to call any time. Passes run one
   * after another: overlapping ones would register two devices, or let an
   * older pass's repo list overwrite a newer one.
   */
  syncWithServer(): Promise<void> {
    const pass = this.syncing.then(() => this.syncPass())
    this.syncing = pass.catch(() => undefined)
    return pass
  }

  private async syncPass() {
    if (this.stopped) return
    this.checkAutoUpdate()
    const { link } = this.options
    const { credential, workspaceId } = this.device
    if (!credential) {
      this.server = "unregistered"
      return
    }
    try {
      // Once per start: refreshes version and harnesses, and keeps the id
      // (and the runs pinned to it) across restarts and re-logins.
      if (!this.registered || !this.device.deviceId) {
        await this.register(credential)
      }
      const deviceId = this.device.deviceId as string
      // Heartbeat first: lease renewal must not wait on anything else.
      const quotas = this.quota?.snapshot().quotas
      const heartbeat = {
        completedDeviceCommands: this.device.completedDeviceCommands,
        failedDeviceCommands: this.device.failedDeviceCommands,
        harnesses: this.harnesses,
        computerUse: { installed: Boolean(this.localComputerDriver), version: this.localComputerDriver?.version ?? null },
        runner: await this.runnerReport(),
        runs: this.supervisor.heartbeatRuns(),
        worktreeDiskBytes: await this.worktrees.diskUsage(),
        ...(quotas ? { quotas } : {}),
      }
      const { leases, revoked, cloudCredential, deviceCommands } = await link.heartbeat(deviceId, heartbeat)
      this.supervisor.renewLeases(leases)
      if (revoked) this.supervisor.revokeLeases(revoked)
      if (this.options.cloudComputer && cloudCredential && this.device.credential === credential) {
        // Persist before switching transport. Keep the current token valid
        // through this pass; the next pass registers with the replacement.
        this.saveDevice({ credential: cloudCredential })
        this.revokeLocalComputerGrants()
        this.registered = false
      }
      this.rescanHarnesses()
      const command = deviceCommands?.[0]
      if (command?.kind === 'uninstall') {
        this.draining = true
        if (this.supervisor.heartbeatRuns().length === 0) {
          this.saveDevice({ completedDeviceCommands: [command.id], failedDeviceCommands: [] })
          try {
            await link.heartbeat(deviceId, { ...heartbeat, runs: [], completedDeviceCommands: [command.id], failedDeviceCommands: [] })
          } catch {
            // Receipt was persisted locally. The server's fixed expiry covers a lost response.
            this.log.warn('Could not confirm uninstall receipt')
          }
          // Stop outside the current sync: stop() waits for this heartbeat tick.
          setImmediate(() => { void this.stop().then(() => uninstallService(() => {
            this.saveDevice({ credential: undefined })
            rmSync(this.paths.secret, { force: true })
          })).catch(() => { this.options.onDrained?.() }) })
        }
        return
      }
      if (command && !this.device.completedDeviceCommands?.includes(command.id) && !this.device.failedDeviceCommands?.some(failure => failure.id === command.id)) {
        if (command.kind === 'redetect' || this.maintenanceIdle()) {
          try {
            if (command.kind === 'redetect') {
              await this.redetectHarnesses()
              this.saveDevice({ completedDeviceCommands: [command.id], failedDeviceCommands: [] })
              // Queue an immediate heartbeat after this sync pass, without re-entering it.
              void this.syncWithServer().catch(() => undefined)
            } else {
              this.startMaintenance(async () => {
                await restartService(command.kind === 'update', () => {
                  if (this.stopped) throw new Error('Daemon stopped during update')
                  this.saveDevice({ completedDeviceCommands: [command.id], failedDeviceCommands: [] })
                }, undefined, () => !this.stopped)
              }, () => {
                this.saveDevice({ completedDeviceCommands: [], failedDeviceCommands: [{ id: command.id, error: 'Device command failed; check daemon service logs.' }] })
              })
            }
          } catch (err) {
            // Do not leak npm output or host details through the management API.
            this.saveDevice({ completedDeviceCommands: [], failedDeviceCommands: [{ id: command.id, error: 'Device command failed; check daemon service logs.' }] })
            this.log.warn({ command_id: command.id, err }, 'Device command failed')
          }
        }
      }
      // Work in progress leaves the machine, so another can take over.
      const checkpointRun = link.checkpointRun?.bind(link)
      if (checkpointRun) await this.supervisor.saveCheckpoints(checkpointRun)
      this.saveDevice({ repos: await link.listRepos(deviceId) })
      this.server = "online"
      await this.outbox.flushAll()
      // Resume only reservations already made while a run was live. Do not
      // hold the heartbeat or recreate uploads after a run has ended.
      for (const entry of this.journal.all()) if (isTerminalRunState(entry.state)) void this.captureUploader.flush(entry.assignment.runId, true)
      if (!this.draining && !this.updating && !this.stopped) {
        // A receipted run blocked while offline may resume only after its
        // server authorization is available; no second recovery scheduler.
        await this.supervisor.resumeAll(true)
        for (const runId of await link.pendingRuns(deviceId)) {
          if (this.refusedRuns.has(runId)) continue
          await this.claimAndStart(runId).catch((error: unknown) =>
            this.log.warn({ run_id: runId, err: error }, "could not start run")
          )
        }
      }
      await this.pruneWorktrees()
      await this.sweepEmptyRuns()
    } catch (error) {
      if (this.device.credential !== credential || this.device.workspaceId !== workspaceId) return
      this.server = "offline"
      if (error instanceof SessionRejectedError) {
        this.rejectDeviceSession(credential)
      } else if (!(error instanceof ServerUnreachableError)) {
        this.log.error({ err: error }, "server sync failed")
      }
    }
  }

  /** A refused credential stops its local work as well as future polling.
   * The supervisor cancels immediately and applies its bounded CLI kill grace. */
  private rejectDeviceSession(credential: string | undefined) {
    // An old in-flight request cannot sign out a newly connected credential.
    if (!credential || this.device.credential !== credential) return
    this.server = "unregistered"
    this.revokeLocalComputerGrants()
    this.registered = false
    this.reviewAbort?.abort()
    this.reviewAbort = null
    this.saveDevice({ credential: undefined })
    for (const runId of this.supervisor?.activeRunIds() ?? []) {
      void this.supervisor.cancel(runId).catch(() => this.log.warn({ run_id: runId }, 'could not stop revoked session'))
    }
    this.log.warn("server refused the device session; sign in again")
  }

  private async claimAndStart(runId: string) {
    if (this.draining || this.updating || this.stopped) {
      throw new DaemonError(DAEMON_RPC_ERRORS.draining, "Daemon is draining")
    }
    this.claimsInFlight++
    try { return await this.claimAndStartInternal(runId) }
    finally { this.claimsInFlight-- }
  }

  private async claimAndStartInternal(runId: string) {
    if (this.draining) {
      throw new DaemonError(DAEMON_RPC_ERRORS.draining, "Daemon is draining")
    }
    const deviceId = this.device.deviceId
    if (!deviceId) throw new ServerUnreachableError("device not registered")
    if (!isSafeId(runId)) return this.refuseRun(runId)
    const existing = this.journal.get(runId)
    if (existing) return this.supervisor.summary(existing)
    const assignment = await this.options.link.claimRun(deviceId, runId)
    if (assignment.runId !== runId) return this.refuseRun(runId)
    if (assignment.expectedRepoRemote) {
      let matches = false
      if (assignment.remoteUrl) {
        // Local runs execute only in the daemon-owned cache. Compare the
        // authorized URLs; prepareRepository fixes that cache's origin before
        // any worktree or child process starts. A user's checkout is irrelevant.
        try {
          const options = { allowFile: daemonTestMode(process.env) }
          matches = normalizeRepository(assignment.remoteUrl, options).key ===
            normalizeRepository(assignment.expectedRepoRemote, options).key
        } catch { /* Invalid or unsupported identities fail closed. */ }
      } else if (this.options.hostedSubscriptions && assignment.computer) {
        // Hosted subscriptions retain their isolated, registered workspace.
        let repo = this.device.repos?.find(item => item.repoId === assignment.repoId)
        if (!repo) {
          this.saveDevice({ repos: await this.options.link.listRepos(deviceId) })
          repo = this.device.repos?.find(item => item.repoId === assignment.repoId)
        }
        matches = Boolean(repo && await verifyExpectedOrigin(repo.path, assignment.expectedRepoRemote))
      }
      if (!matches) {
        const message = "Repository origin does not match the approved repository"
        await this.options.link.completeRun(runId, { stopReason: "error", report: baseReport(message) })
        throw new DaemonError(DAEMON_RPC_ERRORS.unauthorized, message)
      }
    }
    if (assignment.computer && (!this.cloudComputerBroker || assignment.computer.ownerId !== credentialOwner(assignment))) throw new Error('Cloud computer runtime unavailable')
    return await this.supervisor.start(assignment)
  }

  /**
   * A run id that could escape the daemon's dirs never reaches the
   * worktree, outbox or branch code. It cannot use the outbox (keyed by run
   * id), so the error completion goes straight to the server, once.
   */
  private async refuseRun(runId: string): Promise<never> {
    const error = new InvalidIdError(
      `Refusing run id ${JSON.stringify(runId)}: only letters, digits, "_" and "-" (1-64 characters)`,
      { runId }
    )
    if (!this.refusedRuns.has(runId)) {
      this.refusedRuns.add(runId)
      this.log.error({ run_id: runId }, "refusing unsafe run id")
      await this.options.link
        .completeRun(runId, {
          stopReason: "error",
          report: baseReport(error.message),
        })
        .catch((err: unknown) =>
          this.log.warn({ run_id: runId, err }, "could not report refused run")
        )
    }
    throw error
  }

  /** Set once the history has been swept for empty ended runs. */
  private swept = false

  /**
   * Once per start: removes the worktrees and branches that cancelled or
   * failed runs left empty before they were cleaned up on their own. A
   * worktree shared by several runs goes when all of them are done.
   */
  private async sweepEmptyRuns() {
    if (this.swept) return
    this.swept = true
    const active = new Set(this.supervisor.activeRunIds())
    for (const entry of this.journal.all()) {
      if (active.has(entry.assignment.runId)) continue
      if (!isTerminalRunState(entry.state)) continue
      await this.supervisor.discardIfEmpty(entry.assignment.runId)
    }
    // Run branches the journal has no worktree or no record for.
    const paths = this.options.hostedSubscriptions
      ? (this.device.repos ?? []).map(repo => repo.path)
      : this.repositories.paths()
    for (const repoPath of paths) {
      const branches = await this.worktrees
        .runBranches(repoPath)
        .catch(() => [])
      for (const { runId, worktree } of branches) {
        if (active.has(runId)) continue
        const known = this.journal.get(runId)
        if (!known) {
          await this.supervisor.discardOrphan(runId, worktree, repoPath)
        } else if (!known.worktree) {
          await this.supervisor.discardIfEmpty(runId)
        }
      }
    }
  }

  private repository(assignment: RunAssignment): DeviceRepo {
    const settings = this.device.repos?.find(repo => repo.repoId === assignment.repoId)
    if (assignment.remoteUrl) {
      const { key } = normalizeRepository(assignment.remoteUrl, { allowFile: daemonTestMode(process.env) })
      return { ...settings, repoId: assignment.repoId, name: key.split('/').at(-1)!, path: this.repositories.pathFor(assignment.remoteUrl) }
    }
    if (this.options.hostedSubscriptions && assignment.computer && settings) return settings
    throw new DaemonError(DAEMON_RPC_ERRORS.repoNotAllowed, 'Repository URL required; dispatch a new thread.')
  }

  private async pruneWorktrees() {
    const retentionMs = this.options.retentionMs ?? 7 * 24 * 60 * 60 * 1000
    const entries = this.journal.all()
    // Follow-up runs work in the worktree of the run they continue: keep it
    // while any of them is unfinished, and count retention from the last.
    const inUse = new Set(
      entries
        .filter((e) => !isTerminalRunState(e.state))
        .flatMap((e) => (e.worktree ? [e.worktree] : []))
    )
    const lastUsed = new Map<string, string>()
    for (const e of entries) {
      if (!e.worktree) continue
      const seen = lastUsed.get(e.worktree)
      if (!seen || e.updatedAt > seen) lastUsed.set(e.worktree, e.updatedAt)
    }
    const finished = entries
      .filter(
        (e) => !this.supervisor.activeRunIds().includes(e.assignment.runId)
      )
      .filter((e) => isTerminalRunState(e.state))
      .flatMap((e) => {
        const path = this.worktrees.pathFor(e.assignment.runId)
        let repoPath: string | undefined
        try { repoPath = this.repository(e.assignment).path } catch { /* Legacy checkout is never touched. */ }
        return repoPath && !inUse.has(path)
          ? [
              {
                runId: e.assignment.runId,
                repoPath,
                finishedAt: lastUsed.get(path) ?? e.updatedAt,
              },
            ]
          : []
      })
    await this.worktrees.prune(finished, retentionMs)
  }

  status(): DaemonStatus {
    return {
      daemonVersion: DAEMON_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      pid: process.pid,
      dataDir: this.paths.dataDir,
      deviceId: this.device.deviceId ?? null,
      workspaceId: this.device.workspaceId ?? null,
      signedIn: Boolean(this.device.credential),
      server: this.server,
      harnesses: this.harnesses,
      runs: this.supervisor.list(),
      worktreeDiskBytes: this.cachedDiskUsage(),
      pendingUploads: this.outbox.pending(),
      draining: this.draining,
      quotas: this.quota?.snapshot().quotas ?? [],
    }
  }

  private handlers(): RpcHandlers {
    return {
      "daemon.status": () => this.status(),
      "quota.snapshot": () => this.quota?.snapshot() ?? unknownQuotaReport(),
      "daemon.drain": () => {
        this.draining = true
        // Give the response time to reach the caller before sockets close.
        setTimeout(() => {
          void this.stop().then(() => this.options.onDrained?.())
        }, 50)
        return { ok: true as const }
      },
      "device.setCredential": (raw) => {
        this.reviewAbort?.abort()
        this.reviewAbort = null
        const { credential, workspaceId } =
          daemonRpc["device.setCredential"].params.parse(raw)
        // The device id is kept, in every workspace (ADR ORV-284):
        // registering with it in another workspace joins this same device
        // there. A session of someone else gets a new device from the server.
        this.saveDevice({
          credential,
          workspaceId: workspaceId ?? this.device.workspaceId,
        })
        this.revokeLocalComputerGrants()
        this.registered = false
        void this.syncWithServer()
        return { ok: true as const }
      },
      "device.clearCredential": () => {
        this.reviewAbort?.abort()
        this.reviewAbort = null
        // Signed out in the app: stop talking to the server as that person.
        // The device id stays, so signing in again keeps the device.
        this.saveDevice({ credential: undefined })
        this.revokeLocalComputerGrants()
        this.registered = false
        this.server = "unregistered"
        return { ok: true as const }
      },
      "runs.start": (raw) => {
        const { runId } = daemonRpc["runs.start"].params.parse(raw)
        return this.claimAndStart(runId)
      },
      "runs.list": () => this.supervisor.list(),
      "runs.send": async (raw) => {
        const { runId, text } = daemonRpc["runs.send"].params.parse(raw)
        await this.supervisor.send(runId, text)
        return { ok: true as const }
      },
      "runs.cancel": (raw) => {
        const { runId } = daemonRpc["runs.cancel"].params.parse(raw)
        return this.supervisor.cancel(runId)
      },
      "dev.mockRun": async (raw) => {
        const params = daemonRpc["dev.mockRun"].params.parse(raw)
        const memory = this.options.memoryServer
        if (this.options.flavor !== "dev" || !memory) {
          throw new DaemonError(
            DAEMON_RPC_ERRORS.unauthorized,
            "dev.mockRun needs a dev daemon with --server memory"
          )
        }
        await this.syncWithServer()
        const deviceId = this.device.deviceId as string
        const runId = memory.queueRun(deviceId, {
          issueId: `dev-issue-${randomUUID()}`,
          repoId: params.repoId,
          baseBranch: params.baseBranch,
          harness: "mock",
          prompt: "Mock run",
          fixture: params.fixture ?? "success-edit",
          // Placeholder until issues carry their own verify command.
          verifyCommand: params.verifyCommand ?? "git diff --check",
        })
        return this.claimAndStart(runId)
      },
    }
  }

  /** Never blocks status: the walk runs in the background, at most every few minutes. */
  private cachedDiskUsage(): number {
    this.worktrees.diskUsage().catch((err: unknown) => {
      this.log.warn({ err }, "could not measure worktree disk usage")
    })
    return this.worktrees.cachedDiskUsage()
  }

  /** Graceful stop: active runs stay journaled and resume on next start. */

  private maintenanceIdle() {
    return !this.stopped && !this.draining && !this.updating && this.claimsInFlight === 0 && this.supervisor.heartbeatRuns().length === 0
  }

  private startMaintenance(work: () => Promise<void>, failed: () => void = () => {}) {
    if (!this.maintenanceIdle()) return
    this.updating = true
    this.maintenance = work().catch(() => {
      this.updating = false
      failed()
      this.log.warn('Daemon update or restart failed; check service installation and npm configuration')
    }).finally(() => { this.maintenance = null })
  }

  private checkAutoUpdate() {
    const runtime = this.options.autoUpdate
    if (!runtime || this.draining || this.updating) return
    if (this.updateVersion && this.maintenanceIdle()) {
      const version = this.updateVersion
      this.updateVersion = undefined
      this.startMaintenance(async () => {
        await runtime.install(version)
        if (this.stopped) return
        await restartService(false, () => {}, undefined, () => !this.stopped)
      })
    } else if (!this.updateCheck && !this.updateVersion) {
      this.updateCheck = checkLatestVersion(join(this.paths.dataDir, 'auto-update.json'), DAEMON_VERSION, runtime)
        .then(version => { this.updateVersion = version })
        .catch(() => { this.log.warn('Daemon automatic update check failed') })
        .finally(() => { this.updateCheck = null })
    }
  }

  stop(): Promise<void> {
    return (this.stopPromise ??= this.stopInternal())
  }

  private async stopInternal() {
    this.stopped = true
    this.localComputerBroker?.suspend()
    await this.starting?.catch(() => undefined)
    await this.updateCheck
    await this.maintenance
    if (this.timer) clearTimeout(this.timer)
    await this.quota?.stop()
    this.commandsAbort.abort()
    this.reviewAbort?.abort()
    await this.reviewLoop.catch(() => undefined)
    await this.commandsLoop.catch(() => undefined)
    await this.fsLoop.catch(() => undefined)
    await this.tick
    await this.rpc?.close()
    try {
      await this.supervisor?.stop()
    } finally {
      try {
        await this.localComputerBroker?.close()
        await this.cloudComputerBroker?.close()
      } finally {
        const sandbox = this.ownedSandbox
        this.ownedSandbox = null
        if (!this.options.retainResources) await sandbox?.reset().catch((err: unknown) => {
          this.log.warn({ err }, "agent sandbox cleanup failed")
        })
      }
    }
    await this.outbox?.close()
    const release = this.releaseLock
    this.releaseLock = null
    await release?.().catch((err: unknown) => {
      this.log.warn({ err }, "could not release the daemon lock")
    })
    this.log.info("daemon stopped")
    // Close the log file only if this daemon opened it.
    if (!this.options.log) await closeLogger(this.log)
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  return new Daemon(options).start()
}
