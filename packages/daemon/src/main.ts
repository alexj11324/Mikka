import { coordinatorCapable, runNativeCoordinatorJob } from "./coordinator/runner"
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
  realpathSync,
} from "node:fs"
import { arch, hostname, platform } from "node:os"
import { join } from "node:path"

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
import { runPaths } from "./agents/run-context"
import { runVerify } from "./agents/verify"
import { SandboxRuntime, type AgentSandbox } from "./agents/sandbox"
import { buildChildEnv } from "./env"
import { browseFolder } from "./fs-browse"
import {
  DaemonError,
  InvalidIdError,
  RunNotFoundError,
  ServerUnreachableError,
} from "./errors"
import { readJson, writeFileAtomic, writeJsonAtomic } from "./fs-util"
import { detectHarnesses } from "./harnesses"
import { isSafeId } from "./ids"
import { acquireLock } from "./lock"
import { closeLogger, createLogger, type Logger } from "./log"
import { Outbox } from "./outbox"
import { LocalCredentialsSource } from "./quota/local-credentials"
import { QuotaPoller, type QuotaSource } from "./quota/poller"
import { DAEMON_VERSION, daemonPaths, type DaemonPaths } from "./paths"
import { pushDecision, runPolicy } from "./permissions"
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

export * from "./server-link"
export { DAEMON_VERSION, daemonPaths, defaultDataDir } from "./paths"

export interface DaemonOptions {
  dataDir: string
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
  /** Skip CLI detection (tests). */
  harnesses?: HarnessInfo[]
  /**
   * Subscription-quota reader. Omit for the local-credential source.
   * `null` disables polling (tests).
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
  credential?: string
  /**
   * This machine's one device id, the same in every workspace it joins
   * (ADR ORV-284). Kept across sign-outs and workspace switches.
   */
  deviceId?: string
  /** Set by `mikka daemon login --workspace` for multi-workspace users. */
  workspaceId?: string
  /** Last allow-list from the server, so runs resume while offline. */
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

export class Daemon {
  readonly paths: DaemonPaths
  readonly log: Logger
  private releaseLock: (() => Promise<void>) | null = null
  private rpc: RpcServer | null = null
  private outbox!: Outbox
  private journal!: RunJournal
  private worktrees!: WorktreeManager
  supervisor!: RunSupervisor
  private device: DeviceFile = {}
  private harnesses: HarnessInfo[] = []
  private server: DaemonStatus["server"] = "unregistered"
  private timer: NodeJS.Timeout | null = null
  private tick: Promise<void> = Promise.resolve()
  private draining = false
  private stopped = false
  private adapters = new Map<Harness, AgentAdapter>()
  /** Registered (or re-registered) with the server since this start. */
  private nativeCoordinator: Promise<void> | null = null
  private nativeAbort: AbortController | null = null
  private registered = false
  /** Run ids the server sent that were refused as unsafe (reported once). */
  private refusedRuns = new Set<string>()
  private quota: QuotaPoller | null = null
  /** Ends the commands long-poll when the daemon stops. */
  private commandsAbort = new AbortController()
  private commandsLoop: Promise<void> = Promise.resolve()
  private fsLoop: Promise<void> = Promise.resolve()
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
    const secret = this.ensureSecret()
    this.device = loadDeviceFile(readJson(paths.device))
    if (this.options.credential)
      this.saveDevice({ credential: this.options.credential })

    this.journal = new RunJournal(paths.journal)
    this.outbox = new Outbox(
      paths.outbox,
      this.options.link,
      this.log,
      undefined,
      (runId, _item, error) => this.supervisor.markUndeliverable(runId, error)
    )
    this.worktrees = new WorktreeManager(paths.worktrees)
    const adapters = (this.adapters = new Map<Harness, AgentAdapter>([
      [
        "mock",
        new MockAdapter({
          stateDir: paths.adapterState,
          fixturesDir: this.options.fixturesDir,
          speed: this.options.mockSpeed,
        }),
      ],
      ...this.realAdapters(),
    ]))
    this.supervisor = new RunSupervisor({
      journal: this.journal,
      outbox: this.outbox,
      worktrees: this.worktrees,
      adapters,
      repos: () => this.device.repos ?? [],
      log: this.log,
      stallMs: this.options.stallMs,
      revalidateSkillAssignment:async assignment=>{
        const link=this.options.link
        if (!assignment.skillReceipt||!link.validateSkillReceipt||!this.device.credential) throw new Error('Current Skill receipt validation unavailable')
        if (!this.registered||!this.device.deviceId) await this.register(this.device.credential)
        return link.validateSkillReceipt(assignment.runId,assignment.skillReceipt.id)
      },
      verify: this.verifier(),
      publisher: {
        snapshot: ({ worktree, repo }) => snapshotTree(repo.path, worktree),
        publish: ({ runId, worktree, repo, assignment, report, tree }) =>
          publishRun({
            runId,
            repoPath: repo.path,
            worktree,
            tree,
            issueId: assignment.issueId,
            summary: report.summary,
            pushBranch: assignment.pushBranch,
            baseBranch: assignment.baseBranch,
            push: (() => {
              const decision = pushDecision(
                runPolicy(assignment.policy),
                repo.push?.approved === true
              )
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

    // Only harnesses this daemon can drive are advertised: the server must
    // never pin a run here that no adapter would take. (A detected CLI
    // without an adapter yet is left out; the schema has no "unsupported".)
    const detected = this.options.harnesses ?? (await detectHarnesses())
    this.harnesses = detected.filter((info) => this.adapters.has(info.harness)).map(info => ({ ...info, coordinator: coordinatorCapable(info) }))
    // Runs survive restarts: pick up what the journal says was active.
    await this.supervisor.resumeAll()
    if (this.options.quotaSource !== null) {
      this.quota = new QuotaPoller(
        this.options.quotaSource ??
          new LocalCredentialsSource({ log: this.log }),
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
        const commands = await link.fetchCommands(deviceId, wait, {
          signal,
          skipRuns,
        })
        const acted = await this.applyCommands(commands)
        if (this.unacked.size > 0) continue // ack right away
        backoff = 1_000
        // A message for a run with no session yet (still preparing): retry
        // shortly instead of spinning on the same answer.
        if (commands.length > 0 && !acted) await this.pauseCommands(500, signal)
      } catch (error) {
        if (this.stopped || signal.aborted) return
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
    let backoff = 1_000
    while (!this.stopped) {
      const deviceId = this.device.deviceId
      try {
        if (!this.registered || !deviceId) {
          await this.pauseCommands(1_000, signal)
          continue
        }
        const requests = await link.fetchFsRequests(
          deviceId,
          this.options.commandsWaitSeconds ?? FS_REQUESTS_MAX_WAIT_SECONDS,
          { signal }
        )
        backoff = 1_000
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
        if (!(error instanceof ServerUnreachableError))
          this.log.warn({ err: error }, "answering folder requests failed")
        await this.pauseCommands(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  /** Waits `ms`, or less if the daemon stops or the device registers. */
  private pauseCommands(ms: number, signal: AbortSignal): Promise<void> {
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

  private sandbox: AgentSandbox | null | undefined

  /** The agent sandbox (one per daemon), or null where there is none. */
  private agentSandbox(): AgentSandbox | null {
    this.sandbox ??=
      this.options.agentSandbox === undefined
        ? SandboxRuntime.supported()
          ? new SandboxRuntime(async ({ host }) => {
              // Approval cards come later; an unlisted host is denied.
              this.log.warn({ host }, "agent network request denied")
              return false
            })
          : null
        : this.options.agentSandbox
    return this.sandbox
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
        env: buildChildEnv(),
        timeoutMs,
        signal,
        readOnly,
      })
    }
  }

  /**
   * Claude Code, Codex and Cursor. Claude Code is confined by the sandbox
   * its own SDK turns on (the adapter's `settings`); the other two run
   * inside the daemon's `AgentSandbox`.
   */
  private realAdapters(): [Harness, AgentAdapter][] {
    const sandbox = this.agentSandbox()
    if (!sandbox) return []
    const stateDir = this.paths.adapterState
    const bin = this.options.harnessBinaries ?? {}
    return [
      ["claude_code", new ClaudeAdapter({ stateDir, binary: bin.claude_code })],
      ["codex", new CodexAdapter({ sandbox, stateDir, binary: bin.codex })],
      ["cursor", new CursorAdapter({ sandbox, stateDir, binary: bin.cursor })],
    ]
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
    const { deviceId } = await this.options.link.registerDevice(
      credential,
      {
        name: hostname(),
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        daemonVersion: DAEMON_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        harnesses: this.harnesses,
        ...(this.device.workspaceId
          ? { workspaceId: this.device.workspaceId }
          : {}),
      },
      this.device.deviceId
    )
    if (deviceId !== this.device.deviceId) {
      this.saveDevice({ deviceId })
      this.log.info({ device_id: deviceId }, "device registered")
    }
    this.registered = true
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
    const { link } = this.options
    const credential = this.device.credential
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
      const { leases, revoked } = await link.heartbeat(deviceId, {
        harnesses: this.harnesses,
        runs: this.supervisor.heartbeatRuns(),
        worktreeDiskBytes: await this.worktrees.diskUsage(),
        ...(quotas ? { quotas } : {}),
      })
      this.supervisor.renewLeases(leases)
      if (revoked) this.supervisor.revokeLeases(revoked)
      // Work in progress leaves the machine, so another can take over.
      const checkpointRun = link.checkpointRun?.bind(link)
      if (checkpointRun) await this.supervisor.saveCheckpoints(checkpointRun)
      this.saveDevice({ repos: await link.listRepos(deviceId) })
      this.server = "online"
      await this.outbox.flushAll()
      if (!this.draining) {
        // A receipted run blocked while offline may resume only after its
        // server authorization is available; no second recovery scheduler.
        await this.supervisor.resumeAll(true)
        this.startCoordinatorPass(deviceId)
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
      this.server = "offline"
      if (error instanceof SessionRejectedError) {
        // Signed out on the server: drop the dead credential and wait for
        // `mikka daemon login` (or the app, which signs in again when it
        // sees no credential, ADR 0026).
        this.server = "unregistered"
        this.registered = false
        this.saveDevice({ credential: undefined })
        this.log.warn("server refused the device session; sign in again")
      } else if (!(error instanceof ServerUnreachableError)) {
        this.log.error({ err: error }, "server sync failed")
      }
    }
  }

  private async claimAndStart(runId: string) {
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
    return this.supervisor.start(assignment)
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
    for (const repo of this.device.repos ?? []) {
      const branches = await this.worktrees
        .runBranches(repo.path)
        .catch(() => [])
      for (const { runId, worktree } of branches) {
        if (active.has(runId)) continue
        const known = this.journal.get(runId)
        if (!known) {
          await this.supervisor.discardOrphan(runId, worktree, repo.path)
        } else if (!known.worktree) {
          await this.supervisor.discardIfEmpty(runId)
        }
      }
    }
  }

  private async pruneWorktrees() {
    const retentionMs = this.options.retentionMs ?? 7 * 24 * 60 * 60 * 1000
    const repos = new Map(
      (this.device.repos ?? []).map((r) => [r.repoId, r.path])
    )
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
        const repoPath = repos.get(e.assignment.repoId)
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
        this.nativeAbort?.abort()
        const { credential, workspaceId } =
          daemonRpc["device.setCredential"].params.parse(raw)
        // The device id is kept, in every workspace (ADR ORV-284):
        // registering with it in another workspace joins this same device
        // there. A session of someone else gets a new device from the server.
        this.saveDevice({
          credential,
          workspaceId: workspaceId ?? this.device.workspaceId,
        })
        this.registered = false
        void this.syncWithServer()
        return { ok: true as const }
      },
      "device.clearCredential": () => {
        this.nativeAbort?.abort()
        // Signed out in the app: stop talking to the server as that person.
        // The device id stays, so signing in again keeps the device.
        this.saveDevice({ credential: undefined })
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
          baseBranch: params.baseBranch ?? "HEAD",
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
  /** Never hold up heartbeats, worker cancellation or lease renewal for a chat. */
  private startCoordinatorPass(deviceId: string) {
    const link = this.options.link
    const sandbox = this.agentSandbox()
    if (this.nativeCoordinator || !link.claimCoordinator || !sandbox || this.stopped || !this.harnesses.some(info => info.coordinator)) return
    const controller = new AbortController()
    this.nativeAbort = controller
    this.nativeCoordinator = (async () => {
      const job = await link.claimCoordinator!(deviceId,controller.signal)
      if (!job || controller.signal.aborted) return
      await runNativeCoordinatorJob(job,{
        deviceId, stateDir: join(this.paths.dataDir,"coordinator"),link,signal: controller.signal,sandbox,log: this.log,
        codexBinary: this.options.harnessBinaries?.codex,claudeBinary: this.options.harnessBinaries?.claude_code,
      })
    })().catch(() => {
      if (!controller.signal.aborted) this.log.warn("native Coordinator failed; no fallback model was used")
    }).finally(() => { this.nativeCoordinator = null; this.nativeAbort = null })
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.nativeAbort?.abort()
    await this.nativeCoordinator
    if (this.timer) clearTimeout(this.timer)
    await this.quota?.stop()
    this.commandsAbort.abort()
    await this.commandsLoop.catch(() => undefined)
    await this.fsLoop.catch(() => undefined)
    await this.tick
    await this.rpc?.close()
    await this.supervisor?.stop()
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
