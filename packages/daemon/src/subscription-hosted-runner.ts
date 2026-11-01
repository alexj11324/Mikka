// Linux hosted mode reuses the existing CLI adapters and run supervisor. Provider
// custody stays on Mikka: the CLI gets a placeholder and reaches the model only
// through this run's broker socket.
//
// A hosted run happens on the task's own E2B machine (one task, one machine; no
// Docker: decision 2026-11-01-1312). Anthropic's sandbox-runtime encloses the
// CLI and everything it runs, and is the security boundary: it keeps the
// worker's device credential, its other files and the model key (held by the
// broker in this process) out of the agent's reach. The sandbox has no network;
// the run's broker and public-egress relay sockets are its only way out.
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
import type {
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { nativeBrokerContextSchema, type RunAssignment } from "@mikka/protocol";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import type { AgentSession, StartOptions } from "./adapters/types";
import { credentialDenyRead, daemonSecrets, runPaths } from "./agents/run-context";
import type { spawnCli } from "./agents/child";
import { SandboxRuntime, type AgentSandbox, type SandboxedCommand } from "./agents/sandbox";
import { requireRunToolApproval } from "./agents/tool-approval";
import { createNativeSubscriptionBroker } from "./subscription-native-broker";
import { createApiKeyBroker } from "./api-key-broker";
import type { RunCredential } from "./agents/run-credential";
import type { ServerLink } from "./server-link";
import { readJson, writeJsonAtomic } from "./fs-util";
import { withTaskEnv } from "./task-env";
import type { ComputerBroker } from "./computer/broker.mjs";
import { decide, runDomains, runPolicy } from "./permissions";
import { startPublicEgress, type PublicEgress } from "./agents/public-egress";
import { matchesRunSandboxDomain } from "./agents/run-sandbox-launcher";
import { removeRunCredentials } from "./run-scratch";

const exec = promisify(execFile);
const bootstrap = fileURLToPath(
  new URL("./agents/native-container.mjs", import.meta.url),
);
const computerProxy = fileURLToPath(new URL("./computer/proxy.mjs", import.meta.url));
const placeholder = "mikka-native-broker-placeholder";
const unavailable = (cause?: unknown) =>
  new Error("subscription_hosted_runtime_unavailable", cause === undefined ? undefined : { cause });
/** Why a start failed, in words a person can act on; never argv or env. */
const startFailure = (error: unknown) => {
  const value = error as { stderr?: unknown; message?: unknown };
  const stderr = String(value.stderr ?? "").trim();
  return new Error((stderr || (error instanceof Error ? error.message : String(error))).slice(-500));
};
/**
 * sandbox-runtime allows one owner per process; every runner here shares it.
 * Unix sockets are allowed (a run reaches its broker and egress relay over
 * them), so every socket a run must not reach is hidden by `hostOnly`.
 */
let hostSandbox: SandboxRuntime | undefined;
const sandboxRuntime = () => (hostSandbox ??= new SandboxRuntime(undefined, { allowAllUnixSockets: true }));
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
    throw unavailable();
  },
};

export async function createHostedBotRunner(host: {
  stateDir: string;
  link: ServerLink;
  binaries?: Partial<Record<"codex" | "claude_code", string>>;
  /**
   * Passed only by trusted E2B infrastructure, never by a task. Unused since
   * runs stopped using Docker (decision 2026-11-01-1312); still accepted.
   */
  dockerSocket?: "unix:///run/mikka-container/docker.sock";
  /** Optional trusted request-only desktop broker owned by the cloud daemon. */
  computerBroker?: ComputerBroker;
}) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    !host.link.nativeContext ||
    !host.link.nativeRequest
  )
    throw unavailable();
  if (host.dockerSocket !== undefined && host.dockerSocket !== "unix:///run/mikka-container/docker.sock") throw unavailable();
  // Runs use no Docker (decision 2026-11-01-1312). The template's worker still
  // passes its socket; it is accepted and unused.
  const bareEnv = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  // What no run may read: the worker's device credential, RPC secret, journal
  // and logs, the owner session ledgers, logins in the worker's home, and the
  // Docker socket the machine's infrastructure keeps.
  const hostOnly = (harness: "codex" | "claude_code" | null) => [
    ...credentialDenyRead(harness),
    ...daemonSecrets(dirname(host.stateDir)),
    join(host.stateDir, "native-ledgers"),
    "/run/mikka-container",
  ];
  // Per-run container records from before that decision name nothing this
  // runner creates; a leftover must not block the machine.
  rmSync(join(host.stateDir, "native-resources"), { recursive: true, force: true });
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
  const binaries = { codex, claude_code: claude };
  for (const kind of ["codex", "claude_code"] as const)
    if (binaries[kind]) {
      try {
        binaries[kind] = realpathSync(binaries[kind]!);
        if (!lstatSync(binaries[kind]!).isFile()) delete binaries[kind];
      } catch {
        delete binaries[kind];
      }
    }
  if (!binaries.codex && !binaries.claude_code) throw unavailable();
  // A verify command runs in Anthropic's sandbox-runtime: the worktree (unless
  // read-only) and a private git copy are writable, the worktree's `.git` and
  // the worker's own files are not, and it reaches no network.
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
    let wrapped: SandboxedCommand | undefined;
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
      const home = join(gitCopy, "home");
      mkdirSync(home, { mode: 0o700 });
      wrapped = await sandboxRuntime().wrap(["/bin/sh", "-c", script], {
        allowWrite: [...(readOnly ? [] : [cwd]), gitCopy],
        denyWrite: [join(cwd, ".git")],
        denyRead: hostOnly(null),
        allowDomains: [],
      });
      timing.createMs = Math.round(performance.now() - began);
      phase = "run";
      began = performance.now();
      const result = await exec("/bin/sh", ["-c", wrapped.command], {
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
      wrapped?.release();
      rmSync(gitCopy, { recursive: true, force: true });
    }
  };
  return {
    harnesses: Object.keys(binaries).filter(
      (kind) => binaries[kind as keyof typeof binaries],
    ) as ("codex" | "claude_code")[],
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
        options.continueSession
      )
        throw unavailable();
      const lifetime = new AbortController();
      let closed = false;
      let closing: Promise<void> | undefined;
      let computerGrant: ReturnType<ComputerBroker["spec"]>;
      type Broker = Awaited<ReturnType<typeof createNativeSubscriptionBroker>>;
      let broker: Broker | undefined;
      let brokerStarting: Promise<Broker> | undefined;
      let egress: PublicEgress | undefined;
      let egressStarting: Promise<PublicEgress> | undefined;
      // This run's process groups: the sandbox leads each, the bootstrap, the CLI and its children follow.
      const children = new Set<ReturnType<typeof spawn>>();
      let confined: SandboxedCommand | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let offRevoke = () => {};
      const assertOpen = () => {
        if (closed || gate.revoked || lifetime.signal.aborted) throw unavailable();
      };
      const live = async () => {
        assertOpen();
        if (!await gate.checkLive()) {
          gate.revoke();
          throw unavailable();
        }
        assertOpen();
      };
      const close = () => {
        if (closing) return closing;
        // Fence new work before awaiting anything.
        closed = true;
        clearInterval(timer);
        // Publish the shared close promise before abort emits synchronous child
        // callbacks; those callbacks can re-enter close through adapter teardown.
        closing = Promise.resolve().then(async () => {
          const brokerClosed = (async () => {
            await brokerStarting?.catch(() => undefined);
            await broker?.close();
            await egressStarting?.catch(() => undefined);
            await egress?.close();
          })();
          // Observe failures immediately while the CLI is still stopping;
          // the finally below still propagates the broker cleanup failure.
          void brokerClosed.catch(() => undefined);
          try {
            await Promise.all([...children].map((child) => stopGroup(child)));
            confined?.release();
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
          const context = () =>
            host.link.nativeContext!(assignment.deviceId, assignment.runId, lifetime.signal);
          const first = nativeBrokerContextSchema.parse(await context());
          await live();
          if (first.route !== selected.route || first.modelId !== options.model)
            throw unavailable();
          const revision = first.revision;
          const check = async () => {
            await live();
            const current = await context();
            await live();
            if (
              current.revision !== revision ||
              current.accountId !== first.accountId ||
              current.route !== first.route ||
              current.modelId !== first.modelId
            )
              throw unavailable();
            return current;
          };
          return { first, revision, check };
        })() : undefined;
        // An API-key run is live while its gate is; withdrawing the key stops the run from the server.
        const check: () => Promise<unknown> = subscription?.check ?? live;
        const paths = runPaths(host.stateDir, assignment.runId);
        mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
        const shadow = join(paths.runDir, "runtime-git");
        const emptyHome = join(paths.runDir, "git-bootstrap-home");
        mkdirSync(emptyHome, { recursive: true, mode: 0o700 });
        if (!existsSync(shadow))
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
          );
        await live();
        if (
          !lstatSync(shadow).isDirectory() ||
          !lstatSync(join(shadow, ".git")).isDirectory() ||
          !realpathSync(shadow).startsWith(realpathSync(paths.runDir) + "/")
        )
          throw unavailable();
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
        // Only a subscription session is resumed from its ledger; an API-key run starts fresh.
        const previous = scope ? readJson(ledger) as
          { scope: typeof scope; sessionId: string } | undefined : undefined;
        if (
          scope &&
          existsSync(ledger) &&
          (!previous ||
            JSON.stringify(previous.scope) !== JSON.stringify(scope) ||
            typeof previous.sessionId !== "string")
        )
          throw unavailable();
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
        const readyBroker = await brokerStarting;
        await live();
        // The CLI's proxy is a public-destination relay; each connection
        // rechecks this run's current policy.
        const githubCli = options.github ? (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'gh')).find(file => existsSync(file)) : undefined;
        if (options.github && !githubCli) throw new Error('Install GitHub CLI (gh) in the cloud worker image');
        const githubDomains = options.github ? ['github.com', 'api.github.com', new URL(options.github.endpoint).host] : [];
        const egressMaximum = runDomains(runPolicy(options.policy), [...(options.networkAllow ?? []), ...githubDomains]);
        if (egressMaximum.length) {
          egressStarting = startPublicEgress({
            signal: lifetime.signal,
            authorize: async (destination, signal) => matchesRunSandboxDomain(destination, egressMaximum)
              && await gate.preapprovedNetwork({runId: assignment.runId, harness: kind, requestId: 'hosted-egress', method: 'sandbox/network', input: destination}, signal),
          }).then(created => { egress = created; return created; });
          await egressStarting;
          await live();
        }
        const cwd = realpathSync(options.cwd);
        const runDir = realpathSync(paths.runDir);
        if (
          !lstatSync(runDir).isDirectory() ||
          !runDir.startsWith(realpathSync(host.stateDir) + "/runs/")
        ) {
          await close();
          throw unavailable();
        }
        const computer = assignment.computer;
        if (computer && (!host.computerBroker || (selected && computer.ownerId !== selected.ownerId))) {
          await close();
          throw unavailable();
        }
        computerGrant = computer ? host.computerBroker!.spec(assignment.runId, decide("computer_use", { policy: assignment.policy }), { display: computer.display }) : undefined;
        if (computer && !computerGrant) { await close(); throw unavailable(); }
        const computerMcp = computerGrant ? {
          command: process.execPath, args: [computerProxy, computerGrant.socketPath, computerGrant.token, "--captures"], env: {},
        } : undefined;
        await live();
        // The CLI's args reach the bootstrap over stdin, so one wrapped command
        // serves every start of this run.
        const wrapStarted = performance.now();
        confined = await sandboxRuntime().wrap([process.execPath, bootstrap], {
          allowWrite: [...(options.policy?.readOnly ? [] : [cwd]), runDir],
          denyWrite: [join(cwd, ".git"), ...(options.policy?.readOnly ? [cwd] : [])],
          denyRead: hostOnly(kind),
          allowDomains: [],
        });
        console.info(`run ${assignment.runId}: hosted sandbox ready in ${Math.round(performance.now() - wrapStarted)}ms`);
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
              throw unavailable();
          // 4e3: the user variables arrive through their own channel, after the platform guard above.
          const task = withTaskEnv(env, assignment.taskEnv);
          if (task.dropped.length) console.warn(`run ${assignment.runId}: skipped reserved task variables ${task.dropped.join(", ")}`);
          // Its own process group, so a stop reaches the CLI's children too.
          const child = spawn("/bin/sh", ["-c", confined!.command], {
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
              publicEgress: Boolean(egress),
              ...(egress ? { egressSocket: egress.socketPath } : {}),
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
                    if (token !== placeholder) throw unavailable();
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
                  subscriptionAuth: {
                    accountId: subscription!.first.accountId,
                    verify: async () => {
                      await check();
                    },
                    token: async () => {
                      const current = await subscription!.check();
                      return {
                        accessToken: placeholder,
                        chatgptAccountId: current.accountId,
                        chatgptPlanType: current.plan,
                      };
                    },
                  },
                })
              : new ClaudeAdapter({
                  stateDir: host.stateDir,
                  onHostedSession: record,
                  computerMcp,
                  spawnHosted: (config, token) => {
                    if (token !== placeholder) throw unavailable();
                    return spawnHosted(config);
                  },
                  subscriptionAuth: {
                    brokered: true,
                    accountId: subscription!.first.accountId,
                    verify: async () => {
                      await check();
                    },
                    token: async () => {
                      const current = await subscription!.check();
                      return {
                        accessToken: placeholder,
                        accountId: current.accountId,
                        expiresAt: current.expiresAt,
                      };
                    },
                  },
                });
          const runtimeOptions = { ...options, credential: placeholderCredential, ...(githubCli ? { githubRuntime: { nodeBinary: process.execPath, ghBinary: githubCli } } : {}) };
          const session = previous
            ? await adapter.resume(previous.sessionId, runtimeOptions)
            : await adapter.start(runtimeOptions);
          // A quick, successful adapter may already have ended and revoked its
          // gate here. Preserve its terminal events; sends/spawns/provider work
          // remain fenced by close, and do not install a new monitor after it.
          let checking = false;
          if (!closed) timer = setInterval(() => {
            if (checking || closed) return;
            checking = true;
            void check()
              .catch(async () => {
                try { await session.cancel(); }
                finally { await close(); }
              })
              .finally(() => {
                checking = false;
              })
              .catch(() => undefined);
          }, 1000);
          timer?.unref();
          const finish = async () => {
            clearInterval(timer);
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
          // Keep why the CLI did not start: a cleanup failure must not replace it.
          const reason = startFailure(error);
          try {
            await close();
          } catch (cleanup) {
            throw unavailable(new AggregateError([reason, cleanup]));
          }
          if (!(error instanceof Error && error.message === "subscription_hosted_runtime_unavailable"))
            console.warn(`run ${assignment.runId}: hosted CLI did not start: ${reason.message}`);
          throw unavailable(reason);
        }
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
