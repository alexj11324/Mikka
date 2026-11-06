// Linux hosted mode reuses the existing CLI adapters and run supervisor. Provider
// custody stays on Mikka: the CLI gets a placeholder and reaches the model only
// through this run's broker socket.
//
// A hosted run happens on the task's own E2B machine (one task, one machine; no
// Docker: decision 2026-11-01-1312). The E2B sandbox is the only boundary: the
// CLI runs directly as the machine's default user, with no sandbox inside it
// (decision 2026-11-01-2335). The model key stays in this process's broker;
// the CLI reaches the model only through the run's broker socket.
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { harnessReportsModel, nativeBrokerContextSchema, type HarnessInfo, type RunAssignment } from "@mikka/protocol";
import { ClaudeAdapter, ClaudeInitializationError } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import type { AgentSession, StartOptions } from "./adapters/types";
import { runPaths } from "./agents/run-context";
import type { spawnCli } from "./agents/child";
import type { AgentSandbox } from "./agents/sandbox";
import { RUN_CONTROL_FALLBACK_MS, requireRunToolApproval } from "./agents/tool-approval";
import { createNativeSubscriptionBroker } from "./subscription-native-broker";
import { DaemonError, ServerUnreachableError } from "./errors";
import { ProviderFailureError } from "@mikka/protocol/provider-failure";
import { CodedError, findCodedError, logCodedError } from "@mikka/protocol/coded-error";
import type { UserErrorDetail } from "@mikka/protocol/user-error-codes";
import { createApiKeyBroker } from "./api-key-broker";
import type { RunCredential } from "./agents/run-credential";
import type { ServerLink } from "./server-link";
import type { RunJournal } from "./runs/journal";
import { readJson, writeJsonAtomic } from "./fs-util";
import { withTaskEnv } from "./task-env";
import type { ComputerBroker } from "./computer/broker.mjs";
import { decide } from "./permissions";
import { removeRunCredentials } from "./run-scratch";
import { daemonTracer, runIdHash } from "./tracing";

const exec = promisify(execFile);
const bootstrap = fileURLToPath(
  new URL("./agents/native-container.mjs", import.meta.url),
);
const computerProxy = fileURLToPath(new URL("./computer/proxy.mjs", import.meta.url));
const placeholder = "mikka-native-broker-placeholder";
/** How long before a subscription token expires its run re-reads the broker context. */
const SUBSCRIPTION_REFRESH_LEAD_MS = 60_000;
/** Without a push, a run's background subscription context read runs at most this often. */
export const SUBSCRIPTION_TIMED_FLOOR_MS = RUN_CONTROL_FALLBACK_MS;
type Detail = UserErrorDetail<"subscription_hosted_runtime_unavailable">;
/** One code for the UI; the detail says which check failed, the cause is kept (decision 2026-11-05-0330). */
const unavailable = (detail: Detail, cause?: unknown) =>
  cause instanceof ClaudeInitializationError ? new Error(cause.code, { cause })
    : new CodedError("subscription_hosted_runtime_unavailable", { detail, cause });
const isUnavailable = (error: unknown): error is CodedError =>
  error instanceof CodedError && error.code === "subscription_hosted_runtime_unavailable";
/** Why a start failed, in words a person can act on; never argv or env. */
const startFailure = (error: unknown) => {
  if (error instanceof ClaudeInitializationError || error instanceof ProviderFailureError) return error;
  const value = error as { stderr?: unknown; message?: unknown };
  const stderr = String(value.stderr ?? "").trim();
  return new Error((stderr || (error instanceof Error ? error.message : String(error))).slice(-500));
};
/** SIGTERM a run's process group, then SIGKILL whatever is left of it. */
async function stopGroup(child: ReturnType<typeof spawn>, graceMs = 3000) {
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-child.pid!, name); } catch {}
  };
  if (child.pid === undefined) return;
  if (child.exitCode === null && child.signalCode === null) {
    signal("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, graceMs);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  // The CLI's own children (MCP servers, shells) share the group.
  signal("SIGKILL");
}
const blockedSandbox: AgentSandbox = {
  kind: "none",
  async wrap() {
    throw unavailable("host_unsupported");
  },
};

/**
 * The CLI each harness runs on a cloud machine: the one passed in, else Claude Code from the bundled
 * agent SDK and Codex from PATH (E2B's own template CLI). The model probe at template build time and
 * at daemon start asks these same binaries, so what it reports is what a run here uses.
 */
export function hostedBinaries(passed?: Partial<Record<"codex" | "claude_code", string>>): Partial<Record<"codex" | "claude_code", string>> {
  const host = { binaries: passed };
  const require = createRequire(import.meta.url);
  let claude = host.binaries?.claude_code;
  try {
    const bundled = createRequire(
      require.resolve("@anthropic-ai/claude-agent-sdk"),
    );
    claude ??= join(
      dirname(
        bundled.resolve(
          "@anthropic-ai/claude-agent-sdk-linux-x64/package.json",
        ),
      ),
      "claude",
    );
  } catch {}
  const codex =
    host.binaries?.codex ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((dir) => join(dir, "codex"))
      .find((path) => existsSync(path));
  const binaries: Partial<Record<"codex" | "claude_code", string>> = { codex, claude_code: claude };
  for (const kind of ["codex", "claude_code"] as const)
    if (binaries[kind]) {
      try {
        binaries[kind] = realpathSync(binaries[kind]!);
        if (!lstatSync(binaries[kind]!).isFile()) delete binaries[kind];
      } catch {
        delete binaries[kind];
      }
    }
  return binaries;
}

export async function createHostedBotRunner(host: {
  stateDir: string;
  link: ServerLink;
  /** The daemon journal binds question answers to the actual retained run/worktree. */
  journal?: Pick<RunJournal, "get">;
  binaries?: Partial<Record<"codex" | "claude_code", string>>;
  /**
   * Passed only by trusted E2B infrastructure, never by a task. Unused since
   * runs stopped using Docker (decision 2026-11-01-1312); still accepted.
   */
  dockerSocket?: "unix:///run/mikka-container/docker.sock";
  /** Optional trusted request-only desktop broker owned by the cloud daemon. */
  computerBroker?: ComputerBroker;
  /**
   * The models this machine's CLI reported for a harness (the daemon's model probe, model-probe.ts),
   * or null when it reported none. Claude full IDs absent from its shortcut menu require the broker
   * to verify the run's exact account catalogue. Codex still requires its CLI report. Neither path
   * substitutes a different model when evidence is missing.
   */
  reportedModels?: (harness: "codex" | "claude_code") => Promise<Pick<HarnessInfo, "models" | "modelSlots"> | null>;
}) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    !host.link.nativeContext ||
    !host.link.nativeRequest
  )
    throw unavailable("host_unsupported");
  if (host.dockerSocket !== undefined && host.dockerSocket !== "unix:///run/mikka-container/docker.sock") throw unavailable("host_unsupported");
  // Runs use no Docker (decision 2026-11-01-1312). The template's worker still
  // passes its socket; it is accepted and unused.
  const bareEnv = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  // Per-run container records from before that decision name nothing this
  // runner creates; a leftover must not block the machine.
  rmSync(join(host.stateDir, "native-resources"), { recursive: true, force: true });
  const binaries = hostedBinaries(host.binaries);
  if (!binaries.codex && !binaries.claude_code) throw unavailable("cli_missing");
  // A verify command runs directly on the task's machine against a private git
  // copy, so it cannot change the worktree's own `.git`.
  const command = async (
    worktree: string,
    script: string,
    readOnly: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => {
    const timing = { createMs: 0, runMs: 0 };
    let phase: "create" | "run" = "create";
    let began = performance.now();
    const gitCopy = mkdtempSync(join(host.stateDir, "native-verify-git-"));
    try {
      const cwd = realpathSync(worktree);
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "clone",
          "--no-hardlinks",
          "--no-checkout",
          "--",
          cwd,
          join(gitCopy, "repo"),
        ],
        {
          env: {
            ...bareEnv,
            HOME: gitCopy,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
          timeout: 30000,
          signal,
          maxBuffer: 1024 * 1024,
        },
      );
      const safeGit = join(gitCopy, "repo", ".git");
      // --no-checkout leaves no index; verification uses the existing worktree.
      await exec("git", ["--git-dir", safeGit, "read-tree", "HEAD"], {
        env: { ...bareEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        timeout: 30000, signal, maxBuffer: 1024 * 1024,
      });
      const home = join(gitCopy, "home");
      mkdirSync(home, { mode: 0o700 });
      timing.createMs = Math.round(performance.now() - began);
      phase = "run";
      began = performance.now();
      const result = await exec("/bin/sh", ["-c", script], {
        cwd,
        env: {
          ...bareEnv,
          HOME: home,
          TMPDIR: home,
          GIT_DIR: safeGit,
          GIT_WORK_TREE: cwd,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
        timeout: timeoutMs,
        signal,
        maxBuffer: 1024 * 1024,
      });
      timing.runMs = Math.round(performance.now() - began);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        output: (result.stdout + result.stderr).slice(-4000),
        timing,
      };
    } catch (error) {
      const value = error as {
        code?: number;
        signal?: string;
        killed?: boolean;
      };
      timing[phase === "create" ? "createMs" : "runMs"] = Math.round(
        performance.now() - began,
      );
      return {
        exitCode: typeof value.code === "number" ? value.code : null,
        signal: value.signal ?? null,
        timedOut: !!value.killed && !signal?.aborted,
        output:
          phase === "create"
            ? "hosted_sandbox_unavailable"
            : "hosted_command_failed",
        timing,
      };
    } finally {
      rmSync(gitCopy, { recursive: true, force: true });
    }
  };
  return {
    harnesses: Object.keys(binaries).filter(
      (kind) => binaries[kind as keyof typeof binaries],
    ) as ("codex" | "claude_code")[],
    /** The CLI each harness runs, so the daemon's model probe asks the same binary. */
    binaries: { ...binaries } as Partial<Record<"codex" | "claude_code", string>>,
    command,
    async start(
      assignment: RunAssignment,
      options: StartOptions,
    ): Promise<AgentSession> {
      const gate = requireRunToolApproval(options.runId, options.toolApproval);
      // A run has a subscription binding or its own API key, never both. The
      // key stays in this worker's broker; the container gets a placeholder.
      const selected = assignment.subscriptionBinding;
      const apiKey = assignment.modelCredential;
      const kind = assignment.harness;
      const protocol = kind === "codex" ? "openai" as const : "anthropic" as const;
      if (
        Boolean(selected) === Boolean(apiKey) ||
        options.runId !== assignment.runId ||
        (kind !== "codex" && kind !== "claude_code") ||
        !binaries[kind] ||
        (selected && (selected.consumerId.length !== 36 ||
          selected.route !==
            (kind === "codex" ? "codex_cli" : "claude_code_cli"))) ||
        (apiKey?.kind === "provider" && apiKey.protocol !== protocol) ||
        (assignment.requireSessionResume && !selected) ||
        (options.continueSession && (!selected || !assignment.requireSessionResume))
      )
        throw unavailable("assignment_invalid");
      const continuation = options.continueSession;
      if (selected && assignment.requireSessionResume) {
        const sourceId = continuation?.runId ?? assignment.runId;
        const source = host.journal?.get(sourceId);
        const binding = source?.assignment.subscriptionBinding;
        if (!assignment.resumeSessionId || !assignment.continuesRunId || !source?.worktree ||
          source.sessionId !== assignment.resumeSessionId ||
          (continuation && (continuation.runId !== assignment.continuesRunId || continuation.sessionId !== assignment.resumeSessionId)) ||
          (!continuation && source.questionResumeState !== "accepted") ||
          source.assignment.harness !== kind || source.assignment.model !== assignment.model || options.model !== assignment.model ||
          source.assignment.effort !== assignment.effort || options.effort !== assignment.effort ||
          source.assignment.deviceId !== assignment.deviceId || source.assignment.issueId !== assignment.issueId ||
          source.assignment.repoId !== assignment.repoId || realpathSync(source.worktree) !== realpathSync(options.cwd) ||
          !binding || binding.bindingId !== selected.bindingId || binding.ownerId !== selected.ownerId ||
          binding.workspaceId !== selected.workspaceId || binding.consumerId !== selected.consumerId || binding.route !== selected.route)
          throw unavailable("resume_mismatch");
      }
      // Claude's shortcut menu is not exhaustive. A full ID can instead be
      // confirmed by this run's server-authorized account catalogue below.
      let requireModelCatalogue = false;
      if (selected && host.reportedModels) {
        const report = await daemonTracer.span("daemon.adapter.model_report", { "mikka.harness": kind, "mikka.run.id_hash": runIdHash(assignment.runId) }, () => host.reportedModels!(kind)).catch(() => null);
        if (!options.model) throw new Error("subscription_model_not_reported");
        if (!report || harnessReportsModel(report, options.model) !== true) {
          if (kind !== 'claude_code') throw new Error("subscription_model_not_reported");
          requireModelCatalogue = true;
        }
      }
      const lifetime = new AbortController();
      const traceAttributes = { "mikka.harness": kind, "mikka.run.id_hash": runIdHash(assignment.runId) };
      // Fixed diagnostic fields only. These callbacks can fail after the first
      // context succeeds; the adapters deliberately hide their raw errors.
      type StartupPhase = "context_initial" | "context_check" | "token" | "verify" | "adapter_start";
      const startup: {
        phase: StartupPhase;
        contextReady: boolean;
        brokerReady: boolean;
        tokenRequested: boolean;
        tokenCheckPassed: boolean;
        verifyRequested: boolean;
        verifyCheckPassed: boolean;
        expiryValid?: boolean;
        expiryFuture?: boolean;
        sameRevision?: boolean;
        sameAccount?: boolean;
        sameRoute?: boolean;
        sameModel?: boolean;
      } = { phase: "context_initial", contextReady: false, brokerReady: false, tokenRequested: false, tokenCheckPassed: false, verifyRequested: false, verifyCheckPassed: false };
      let reported = false;
      let started = false;
      const reportFailure = (error: unknown) => {
        if (!selected || reported || (started && (closed || lifetime.signal.aborted))) return;
        reported = true;
        const status = error instanceof DaemonError && error.data && typeof error.data === "object" && "status" in error.data ? error.data.status : undefined;
        const reason = error instanceof ServerUnreachableError ? "server_unreachable"
          : error instanceof DaemonError ? "server_refused"
          : error instanceof Error && error.name === "ZodError" ? "context_invalid"
          : [startup.sameRevision, startup.sameAccount, startup.sameRoute, startup.sameModel].includes(false) ? "context_changed"
          : started ? "runtime_failed" : "startup_failed";
        try {
          options.log.warn({ event: started ? "subscription_runtime_failed" : "subscription_startup_failed", runId: assignment.runId, harness: kind, ...startup, reason,
            ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) }, started ? "Subscription runtime check failed" : "Subscription startup failed");
        } catch { /* Diagnostics never replace the original refusal. */ }
      };
      let closed = false;
      let closing: Promise<void> | undefined;
      let computerGrant: ReturnType<ComputerBroker["spec"]>;
      type Broker = Awaited<ReturnType<typeof createNativeSubscriptionBroker>>;
      let broker: Broker | undefined;
      let brokerStarting: Promise<Broker> | undefined;
      // This run's process groups: the bootstrap leads each, the CLI and its children follow.
      const children = new Set<ReturnType<typeof spawn>>();
      let offMonitor = () => {};
      let offRevoke = () => {};
      const assertOpen = () => {
        if (closed || gate.revoked || lifetime.signal.aborted) throw unavailable("run_closed");
      };
      const live = async () => {
        assertOpen();
        if (!await daemonTracer.span("daemon.adapter.auth.gate", traceAttributes, () => gate.checkLive())) {
          gate.revoke();
          throw unavailable("run_closed");
        }
        assertOpen();
      };
      const close = () => {
        if (closing) return closing;
        // Fence new work before awaiting anything.
        closed = true;
        offMonitor();
        // Publish the shared close promise before abort emits synchronous child
        // callbacks; those callbacks can re-enter close through adapter teardown.
        closing = Promise.resolve().then(async () => {
          const brokerClosed = (async () => {
            await brokerStarting?.catch(() => undefined);
            await broker?.close();
          })();
          // Observe failures immediately while the CLI is still stopping;
          // the finally below still propagates the broker cleanup failure.
          void brokerClosed.catch(() => undefined);
          try {
            await Promise.all([...children].map((child) => stopGroup(child)));
          } finally {
            try { await brokerClosed; }
            finally {
              offRevoke();
              // The session's runtime-home and GitHub config hold no credential once it closes.
              removeRunCredentials(host.stateDir, assignment.runId);
            }
          }
        });
        if (computerGrant) host.computerBroker?.revoke(computerGrant.token);
        lifetime.abort();
        return closing;
      };
      // Hosted adapters inject their own spawns, so they do not install the
      // official sandbox launcher's revocation hook. Own that hook here before
      // the first context/broker/create await, including already-revoked gates.
      offRevoke = gate.onRevoke(() => { void close().catch(() => undefined); });
      try {
        await live();
        const subscription = selected ? await (async () => {
          const context = async (checkAuthority = true) => {
            // A failed infrastructure query is inconclusive, not revocation.
            // Admit no work until a fresh context succeeds, and stop after
            // three attempts. Authoritative refusals are never retried.
            for (let attempt = 0; ; attempt++) {
              if (checkAuthority) await live();
              else assertOpen();
              try {
                return await daemonTracer.span("daemon.adapter.auth.context", traceAttributes, () => host.link.nativeContext!(assignment.deviceId, assignment.runId, lifetime.signal, requireModelCatalogue));
              } catch (error) {
                if (!(error instanceof ServerUnreachableError) || attempt >= 2) throw error;
                await delay(250, undefined, { signal: lifetime.signal });
              }
            }
          };
          const first = nativeBrokerContextSchema.parse(await context());
          await live();
          startup.sameRoute = first.route === selected.route;
          startup.sameModel = first.modelId === options.model;
          if (first.route !== selected.route || first.modelId !== options.model)
            throw unavailable("context_changed");
          startup.contextReady = true;
          const revision = first.revision;
          const check = (phase: StartupPhase = "context_check", checkAuthority = true) => daemonTracer.span("daemon.adapter.auth", traceAttributes, async () => {
            startup.phase = phase;
            try {
              const current = await context(checkAuthority);
              if (checkAuthority) await live();
              else assertOpen();
              startup.sameRevision = current.revision === revision;
              startup.sameAccount = current.accountId === first.accountId;
              startup.sameRoute = current.route === first.route;
              startup.sameModel = current.modelId === first.modelId;
              const expiry = Date.parse(current.expiresAt);
              startup.expiryValid = Number.isFinite(expiry);
              startup.expiryFuture = startup.expiryValid && expiry > Date.now();
              if (
                current.revision !== revision ||
                current.accountId !== first.accountId ||
                current.route !== first.route ||
                current.modelId !== first.modelId ||
                !startup.expiryFuture
              )
                throw unavailable("context_changed");
              return current;
            } catch (error) {
              reportFailure(error);
              throw error;
            }
          });
          // Only the shared background watcher has just checked authority.
          // Every actual provider/tool operation keeps the fresh checks above.
          // It runs on each run-control push and again when the subscription
          // token is due: shortly before it expires (the broker refreshes it),
          // then at expiry itself if it did not move, where the check fails closed.
          // The first context's expiry seeds the watcher, so a run that gets no
          // push still re-reads shortly before its token expires. A read already
          // inside that lead time waits for the expiry itself.
          const firstExpiry = Date.parse(first.expiresAt);
          const firstDue = Number.isFinite(firstExpiry) ? firstExpiry - SUBSCRIPTION_REFRESH_LEAD_MS : undefined;
          let lastExpiry: number | undefined;
          const background = async () => {
            const current = await check("context_check", false);
            const expiry = Date.parse(current.expiresAt);
            const due = expiry === lastExpiry || expiry - SUBSCRIPTION_REFRESH_LEAD_MS <= Date.now() ? expiry : expiry - SUBSCRIPTION_REFRESH_LEAD_MS;
            lastExpiry = expiry;
            return due;
          };
          return { first, revision, check, background, firstDue };
        })() : undefined;
        // An API-key run is live while its gate is; withdrawing the key stops the run from the server.
        const check: () => Promise<unknown> = subscription?.check ?? live;
        const paths = runPaths(host.stateDir, assignment.runId);
        mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
        const shadow = join(paths.runDir, "runtime-git");
        const emptyHome = join(paths.runDir, "git-bootstrap-home");
        mkdirSync(emptyHome, { recursive: true, mode: 0o700 });
        if (!existsSync(shadow)) {
          await daemonTracer.span("daemon.adapter.workspace.shadow_clone", traceAttributes, () => exec(
            "git",
            [
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.fsmonitor=false",
              "clone",
              "--no-hardlinks",
              "--no-checkout",
              "--",
              realpathSync(options.cwd),
              shadow,
            ],
            {
              env: {
                ...bareEnv,
                HOME: emptyHome,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
              },
              timeout: 30000,
              signal: lifetime.signal,
              maxBuffer: 1024 * 1024,
            },
          ));
          // Initialize only a new shadow, preserving staged changes on resume.
          await daemonTracer.span("daemon.adapter.workspace.read_tree", traceAttributes, () => exec("git", ["--git-dir", join(shadow, ".git"), "read-tree", "HEAD"], {
            env: { ...bareEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
            timeout: 30000, signal: lifetime.signal, maxBuffer: 1024 * 1024,
          }));
        }
        await live();
        if (
          !lstatSync(shadow).isDirectory() ||
          !lstatSync(join(shadow, ".git")).isDirectory() ||
          !realpathSync(shadow).startsWith(realpathSync(paths.runDir) + "/")
        )
          throw unavailable("workspace_invalid");
        const ledger = join(
          host.stateDir,
          "native-ledgers",
          assignment.runId + ".json",
        );
        const scope = selected && subscription ? {
          runId: assignment.runId,
          bindingId: selected.bindingId,
          ownerId: selected.ownerId,
          workspaceId: selected.workspaceId,
          consumerId: selected.consumerId,
          route: selected.route,
          revision: subscription.revision,
          accountId: subscription.first.accountId,
          modelId: subscription.first.modelId,
        } : undefined;
        // Legacy ledgers are sufficient: their frozen scope is joined to the
        // daemon's original SID/worktree journal, never inferred from a new run.
        if (continuation && existsSync(ledger)) throw unavailable("ledger_mismatch");
        const previousLedger = continuation
          ? join(host.stateDir, "native-ledgers", continuation.runId + ".json") : ledger;
        const previous = scope ? readJson(previousLedger) as
          { scope: typeof scope; sessionId: string } | undefined : undefined;
        const expectedScope = scope && continuation ? { ...scope, runId: continuation.runId } : scope;
        if (scope && ((existsSync(previousLedger) &&
          (!previous || JSON.stringify(previous.scope) !== JSON.stringify(expectedScope) || typeof previous.sessionId !== "string")) ||
          (assignment.requireSessionResume && (!previous || previous.sessionId !== assignment.resumeSessionId))))
          throw unavailable("ledger_mismatch");
        if (scope) mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
        const record = async (sessionId: string) => {
          assertOpen();
          if (scope) writeJsonAtomic(ledger, { scope, sessionId });
        };
        brokerStarting = apiKey ? createApiKeyBroker({
          root: join(host.stateDir, "native-brokers"),
          protocol,
          credential: apiKey,
          check,
        }) : createNativeSubscriptionBroker({
          root: join(host.stateDir, "native-brokers"),
          log: options.log,
          revision: subscription!.revision,
          check,
          worker: {
            nativeRequest: async (_revision, payload, signal) => {
              await live();
              const upstream = await host.link.nativeRequest!(
                assignment.deviceId,
                assignment.runId,
                payload,
                AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]),
              );
              try { await live(); }
              catch (error) {
                await upstream.body.cancel().catch(() => undefined);
                throw error;
              }
              return upstream;
            },
          },
        }).then(created => {
          broker = created;
          return created;
        });
        const readyBroker = await daemonTracer.span("daemon.adapter.auth.broker", traceAttributes, () => brokerStarting!);
        startup.brokerReady = true;
        await live();
        const githubCli = options.github ? (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'gh')).find(file => existsSync(file)) : undefined;
        if (options.github && !githubCli) throw new Error('Install GitHub CLI (gh) in the cloud worker image');
        const cwd = realpathSync(options.cwd);
        const runDir = realpathSync(paths.runDir);
        if (
          !lstatSync(runDir).isDirectory() ||
          !runDir.startsWith(realpathSync(host.stateDir) + "/runs/")
        ) {
          await close();
          throw unavailable("workspace_invalid");
        }
        const computer = assignment.computer;
        if (computer && (!host.computerBroker || (selected && computer.ownerId !== selected.ownerId))) {
          await close();
          throw unavailable("computer_unavailable");
        }
        computerGrant = computer ? host.computerBroker!.spec(assignment.runId, decide("computer_use", { policy: assignment.policy }), { display: computer.display }) : undefined;
        if (computer && !computerGrant) { await close(); throw unavailable("computer_unavailable"); }
        const computerMcp = computerGrant ? {
          command: process.execPath, args: [computerProxy, computerGrant.socketPath, computerGrant.token, "--captures"], env: {},
        } : undefined;
        await live();
        const spawnHosted = (config: SpawnOptions): SpawnedProcess => {
          assertOpen();
          const home = join(runDir, "runtime-home");
          mkdirSync(home, { recursive: true, mode: 0o700 });
          // A run may not import its real host HOME or any platform environment.
          const env = {
            ...config.env,
            HOME: kind === "claude_code" ? (config.env.HOME ?? home) : home,
            PATH: `${options.github ? join(runDir, 'github', 'bin') + ':' : ''}/usr/local/bin:/usr/bin:/bin`,
            GIT_DIR: join(shadow, ".git"),
            GIT_WORK_TREE: cwd,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          } as Record<string, string>;
          for (const [key, value] of Object.entries(env))
            if (
              value !== undefined &&
              (/INFISICAL|E2B_API_KEY|REFRESH_TOKEN|^AWS_|^GOOGLE_|^OPENAI_|^ANTHROPIC_.*(?:KEY|TOKEN)|SECRET|PASSWORD/.test(
                key,
              ) ||
                ((key === "CLAUDE_CODE_OAUTH_TOKEN" || key === "MIKKA_MODEL_API_KEY") && value !== placeholder))
            )
              throw unavailable("env_not_clean");
          // 4e3: the user variables arrive through their own channel, after the platform guard above.
          const task = withTaskEnv(env, assignment.taskEnv);
          if (task.dropped.length) console.warn(`run ${assignment.runId}: skipped reserved task variables ${task.dropped.join(", ")}`);
          // Its own process group, so a stop reaches the CLI's children too.
          // The CLI's args reach the bootstrap over stdin.
          const child = spawn(process.execPath, [bootstrap], {
            cwd,
            env: bareEnv,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          children.add(child);
          child.once("exit", () => children.delete(child));
          const stop = AbortSignal.any([lifetime.signal, ...(config.signal ? [config.signal] : [])]);
          if (stop.aborted) void stopGroup(child);
          else stop.addEventListener("abort", () => { void stopGroup(child); }, { once: true });
          child.stdin.write(
            JSON.stringify({
              kind,
              args: config.args,
              cwd,
              env: task.env,
              cli: binaries[kind],
              node: process.execPath,
              brokerSocket: readyBroker.socket,
              ...(options.github ? { githubBin: join(runDir, 'github', 'bin') } : {}),
            }) + "\n",
          );
          return child;
        };
        const codexSpawn: typeof spawnCli = async (_sandbox, argv, input) => {
          await check();
          const child = spawnHosted({
            command: argv[0],
            args: argv.slice(1),
            cwd: input.cwd,
            env: input.env,
            signal: new AbortController().signal,
          }) as ReturnType<typeof spawn>;
          child.stderr?.resume();
          const exited = new Promise<{
            code: number | null;
            signal: string | null;
          }>((resolve) => {
            child.once("exit", (code, signal) => resolve({ code, signal }));
            child.once("error", () => resolve({ code: null, signal: null }));
          });
          return {
            process: child as Awaited<ReturnType<typeof spawnCli>>["process"],
            exited,
            stderrTail: () => "",
            kill: async () => {
              child.kill("SIGTERM");
              await close().catch(() => undefined);
            },
          };
        };
        try {
          startup.phase = "adapter_start";
          // The adapter sees a placeholder in the key's place; the broker adds the key.
          const placeholderCredential: RunCredential | undefined = apiKey && kind === "codex"
            ? { kind: "provider", protocol: "openai", baseUrl: apiKey.kind === "provider" ? apiKey.baseUrl : "https://api.openai.com/v1", key: placeholder }
            : undefined;
          const adapter = apiKey
            ? kind === "codex"
              ? new CodexAdapter({ stateDir: host.stateDir, sandbox: blockedSandbox, spawnCli: codexSpawn, computerMcp })
              : new ClaudeAdapter({
                  stateDir: host.stateDir,
                  computerMcp,
                  spawnHosted: (config, token) => {
                    if (token !== placeholder) throw unavailable("credential_mismatch");
                    return spawnHosted(config);
                  },
                })
            : kind === "codex"
              ? new CodexAdapter({
                  stateDir: host.stateDir,
                  sandbox: blockedSandbox,
                  spawnCli: codexSpawn,
                  onHostedSession: record,
                  computerMcp,
                  hostedSubscriptionBroker: {
                    verify: async () => {
                      startup.verifyRequested = true;
                      startup.verifyCheckPassed = false;
                      await subscription!.check("verify");
                      startup.verifyCheckPassed = true;
                      startup.phase = "adapter_start";
                    },
                  },
                })
              : new ClaudeAdapter({
                  stateDir: host.stateDir,
                  onHostedSession: record,
                  computerMcp,
                  spawnHosted: (config, token) => {
                    if (token !== placeholder) throw unavailable("credential_mismatch");
                    return spawnHosted(config);
                  },
                  subscriptionAuth: {
                    brokered: true,
                    accountId: subscription!.first.accountId,
                    verify: async () => {
                      startup.verifyRequested = true;
                      startup.verifyCheckPassed = false;
                      await subscription!.check("verify");
                      startup.verifyCheckPassed = true;
                      startup.phase = "adapter_start";
                    },
                    token: async () => {
                      startup.tokenRequested = true;
                      startup.tokenCheckPassed = false;
                      const current = await subscription!.check("token");
                      startup.tokenCheckPassed = true;
                      startup.phase = "adapter_start";
                      return {
                        accessToken: placeholder,
                        accountId: current.accountId,
                        expiresAt: current.expiresAt,
                      };
                    },
                  },
                });
          const runtimeOptions = { ...options, ...(continuation ? { continueSession: continuation } : {}), ...(assignment.requireSessionResume ? { requireSessionResume: true } : {}), credential: placeholderCredential, ...(githubCli ? { githubRuntime: { nodeBinary: process.execPath, ghBinary: githubCli } } : {}) };
          const session = previous && !continuation
            ? await adapter.resume(previous.sessionId, runtimeOptions)
            : await adapter.start(runtimeOptions);
          if (assignment.requireSessionResume && session.sessionId !== assignment.resumeSessionId) {
            await session.cancel();
            throw unavailable("session_mismatch");
          }
          started = true;
          // A quick, successful adapter may already have ended and revoked its
          // gate here. Preserve its terminal events; sends/spawns/provider work
          // remain fenced by close, and do not install a new monitor after it.
          // A fallback or legacy timer tick re-reads the context at most every
          // 20 s (each tick did, about one request every 3 s on cloud runs):
          // changes come by push, at token expiry and with each provider
          // request's own fresh check. Pushes and the expiry always re-read.
          if (!closed) offMonitor = subscription
            ? gate.watch(subscription.background, undefined, { timedFloorMs: SUBSCRIPTION_TIMED_FLOOR_MS, dueAt: subscription.firstDue })
            : gate.watch();
          const finish = async () => {
            offMonitor();
            await close();
          };
          return {
            sessionId: session.sessionId,
            async *events() {
              try {
                yield* session.events();
              } finally {
                await finish();
              }
            },
            send: async (text) => {
              await check();
              assertOpen();
              await session.send(text);
            },
            cancel: async () => {
              try { await session.cancel(); }
              finally { await finish(); }
            },
          };
        } catch (error) {
          reportFailure(error);
          // Keep why the CLI did not start: a cleanup failure must not replace it.
          const reason = startFailure(error);
          try {
            await close();
          } catch (cleanup) {
            throw unavailable("cleanup_failed", new AggregateError([reason, cleanup]));
          }
          if (!isUnavailable(error))
            console.warn(`run ${assignment.runId}: hosted CLI did not start: ${reason.message}`);
          if (isUnavailable(error)) throw error;
          // A check inside the adapter (verify, token) keeps its detail; anything else is adapter_start_failed.
          throw unavailable((findCodedError(error, "subscription_hosted_runtime_unavailable")?.detail as Detail | undefined) ?? "adapter_start_failed", reason);
        }
      } catch (error) {
        reportFailure(error);
        if (error instanceof CodedError) logCodedError(error, { runId: assignment.runId, harness: kind }, options.log);
        await close();
        throw error;
      }
    },
  };
}
