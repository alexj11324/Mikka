// Linux hosted mode reuses the existing CLI adapters and run supervisor. Provider
// custody stays on Mikka; the container mounts only one task's broker socket.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { HOSTED_NATIVE_IMAGE, nativeBrokerContextSchema, type RunAssignment } from "@mikka/protocol";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import type { AgentSession, StartOptions } from "./adapters/types";
import { runPaths, MCP_SERVER_SCRIPT } from "./agents/run-context";
import type { spawnCli } from "./agents/child";
import type { AgentSandbox } from "./agents/sandbox";
import { createNativeSubscriptionBroker } from "./subscription-native-broker";
import type { ServerLink } from "./server-link";
import { readJson, writeJsonAtomic } from "./fs-util";

const exec = promisify(execFile);
const image = HOSTED_NATIVE_IMAGE;
const bootstrap = fileURLToPath(
  new URL("./agents/native-container.mjs", import.meta.url),
);
const placeholder = "mikka-native-broker-placeholder";
const unavailable = () => new Error("subscription_hosted_runtime_unavailable");
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
  /** Passed only by trusted E2B infrastructure, never by a task. */
  dockerSocket?: "unix:///run/mikka-container/docker.sock";
}) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    !host.link.nativeContext ||
    !host.link.nativeRequest
  )
    throw unavailable();
  if (host.dockerSocket !== undefined && host.dockerSocket !== "unix:///run/mikka-container/docker.sock") throw unavailable();
  const bareEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", ...(host.dockerSocket ? { DOCKER_HOST: host.dockerSocket } : {}) };
  // Do not pull, build or provision anything. The operator supplies installed
  // software; this read-only preflight cannot create a cloud resource.
  await exec("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {
    env: bareEnv,
    timeout: 10000,
  }).catch(() => {
    throw unavailable();
  });
  const resources = join(host.stateDir, "native-resources");
  mkdirSync(resources, { recursive: true, mode: 0o700 });
  type Resource = {
    name: string;
    nonce: string;
    state: "creating" | "created";
    id?: string;
    assets?: string;
  };
  const removeResource = async (file: string, record: Resource) => {
    if (
      !/^mikka-native-(?:verify-)?[a-f0-9-]{36}$/.test(record.name) ||
      !/^[a-f0-9-]{36}$/.test(record.nonce)
    )
      throw unavailable();
    let described: { stdout: string };
    try {
      described = await exec(
        "docker",
        [
          "inspect",
          record.id ?? record.name,
          "--format",
          "{{json .Id}}|{{json .Config.Labels}}",
        ],
        { env: bareEnv, timeout: 30000 },
      );
    } catch (error) {
      if (
        record.state === "created" &&
        /No such (?:container|object)/i.test(
          String((error as { stderr?: string }).stderr),
        )
      ) {
        if (
          record.assets?.startsWith(join(host.stateDir, "native-verify-git-"))
        )
          rmSync(record.assets, { recursive: true, force: true });
        rmSync(file, { force: true });
        return;
      }
      throw new Error("native_runtime_cleanup_unconfirmed");
    }
    const [id, labels] = described.stdout
      .trim()
      .split("|")
      .map((part) => JSON.parse(part));
    if (
      labels?.["com.mikka.native.resource"] !== record.nonce ||
      (record.id && record.id !== id)
    )
      throw unavailable();
    await exec("docker", ["rm", "-f", id], { env: bareEnv, timeout: 30000 });
    if (record.assets?.startsWith(join(host.stateDir, "native-verify-git-")))
      rmSync(record.assets, { recursive: true, force: true });
    rmSync(file, { force: true });
  };
  // Only this runner's durable references are considered. An uncertain create
  // with no visible object stays pending; absence is not proof of rollback.
  for (const name of readdirSync(resources))
    if (name.endsWith(".json")) {
      const file = join(resources, name);
      const record = readJson(file) as Resource | undefined;
      if (!record) throw unavailable();
      await removeResource(file, record);
    }
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
  const command = async (
    worktree: string,
    script: string,
    readOnly: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => {
    const name = `mikka-native-verify-${randomUUID()}`;
    const file = join(resources, name + ".json");
    const resource: Resource = { name, nonce: randomUUID(), state: "creating" };
    const timing = { createMs: 0, runMs: 0 };
    let phase: "create" | "run" = "create";
    let began = performance.now();
    const gitCopy = mkdtempSync(join(host.stateDir, "native-verify-git-"));
    resource.assets = gitCopy;
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
      const protectedGit = lstatSync(join(cwd, ".git")).isFile()
        ? join(cwd, ".git")
        : safeGit;
      writeJsonAtomic(file, resource);
      const created = await exec(
        "docker",
        [
          "create",
          "--pull=never",
          "--name",
          name,
          "--label",
          `com.mikka.native.resource=${resource.nonce}`,
          "--init",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          `${process.getuid!()}:${process.getgid!()}`,
          "--memory=1g",
          "--cpus=2",
          "--pids-limit=128",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=128m",
          "-e",
          "HOME=/tmp",
          "-e",
          "GIT_DIR=/runtime-git",
          "-e",
          "GIT_WORK_TREE=/project",
          "-e",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "-e",
          "GIT_CONFIG_SYSTEM=/dev/null",
          "-e",
          "GIT_OPTIONAL_LOCKS=0",
          "-v",
          `${cwd}:/project${readOnly ? ":ro" : ""}`,
          "-v",
          `${protectedGit}:/project/.git:ro`,
          "-v",
          `${safeGit}:/runtime-git`,
          "-w",
          "/project",
          image,
          "/bin/sh",
          "-c",
          script,
        ],
        { env: bareEnv, timeout: 30000, signal, maxBuffer: 1024 * 1024 },
      );
      resource.id = created.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(resource.id)) throw unavailable();
      resource.state = "created";
      writeJsonAtomic(file, resource);
      timing.createMs = Math.round(performance.now() - began);
      phase = "run";
      began = performance.now();
      const result = await exec("docker", ["start", "-a", resource.id], {
        env: bareEnv,
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
            ? "hosted_container_create_failed"
            : "hosted_command_failed",
        timing,
      };
    } finally {
      if (existsSync(file)) await removeResource(file, resource);
      else rmSync(gitCopy, { recursive: true, force: true });
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
      const selected = assignment.subscriptionBinding;
      const kind = assignment.harness;
      if (
        !selected ||
        options.runId !== assignment.runId ||
        (kind !== "codex" && kind !== "claude_code") ||
        !binaries[kind] ||
        selected.consumerId.length !== 36 ||
        selected.route !==
          (kind === "codex" ? "codex_cli" : "claude_code_cli") ||
        options.continueSession
      )
        throw unavailable();
      const context = () =>
        host.link.nativeContext!(assignment.deviceId, assignment.runId);
      const first = nativeBrokerContextSchema.parse(await context());
      if (first.route !== selected.route || first.modelId !== options.model)
        throw unavailable();
      const revision = first.revision;
      const check = async () => {
        const current = await context();
        if (
          current.revision !== revision ||
          current.accountId !== first.accountId ||
          current.route !== first.route ||
          current.modelId !== first.modelId
        )
          throw unavailable();
        return current;
      };
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
            maxBuffer: 1024 * 1024,
          },
        );
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
      const scope = {
        runId: assignment.runId,
        bindingId: selected.bindingId,
        ownerId: selected.ownerId,
        workspaceId: selected.workspaceId,
        consumerId: selected.consumerId,
        route: selected.route,
        revision,
        accountId: first.accountId,
        modelId: first.modelId,
      };
      const previous = readJson(ledger) as
        { scope: typeof scope; sessionId: string } | undefined;
      if (
        existsSync(ledger) &&
        (!previous ||
          JSON.stringify(previous.scope) !== JSON.stringify(scope) ||
          typeof previous.sessionId !== "string")
      )
        throw unavailable();
      mkdirSync(dirname(ledger), { recursive: true, mode: 0o700 });
      const record = async (sessionId: string) => {
        writeJsonAtomic(ledger, { scope, sessionId });
      };
      const broker = await createNativeSubscriptionBroker({
        root: join(host.stateDir, "native-brokers"),
        revision,
        check,
        worker: {
          nativeRequest: (_revision, payload, signal) =>
            host.link.nativeRequest!(
              assignment.deviceId,
              assignment.runId,
              payload,
              signal,
            ),
        },
      });
      const name = `mikka-native-${randomUUID()}`;
      const nonce = randomUUID();
      const resourceFile = join(resources, name + ".json");
      const resource: Resource = { name, nonce, state: "creating" };
      let closed = false;
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          closed = true;
          try {
            if (existsSync(resourceFile))
              await removeResource(resourceFile, resource);
          } finally {
            await broker.close();
          }
        })());
      const cwd = realpathSync(options.cwd);
      const runDir = realpathSync(paths.runDir);
      const protectedGit = lstatSync(join(cwd, ".git")).isFile()
        ? join(cwd, ".git")
        : join(shadow, ".git");
      if (
        !lstatSync(runDir).isDirectory() ||
        !runDir.startsWith(realpathSync(host.stateDir) + "/runs/")
      ) {
        await close();
        throw unavailable();
      }
      const containerArgs = [
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `com.mikka.native.resource=${nonce}`,
        "--init",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--memory=1g",
        "--cpus=2",
        "--pids-limit=128",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=128m",
        "-i",
        "-v",
        `${binaries[kind]}:/usr/local/bin/native-cli:ro`,
        "-v",
        `${bootstrap}:/native-container.mjs:ro`,
        "-v",
        `${MCP_SERVER_SCRIPT}:${MCP_SERVER_SCRIPT}:ro`,
        "-v",
        `${broker.socket}:/run/mikka-native.sock:ro`,
        "-v",
        `${cwd}:${cwd}${options.policy?.readOnly ? ":ro" : ""}`,
        "-v",
        `${protectedGit}:${cwd}/.git:ro`,
        "-v",
        `${runDir}:${runDir}`,
        "-w",
        cwd,
        image,
        "node",
        "/native-container.mjs",
      ];
      writeJsonAtomic(resourceFile, resource);
      try {
        const created = await exec("docker", containerArgs, {
          env: bareEnv,
          timeout: 30000,
        });
        resource.id = created.stdout.trim();
        if (!/^[a-f0-9]{64}$/.test(resource.id)) throw unavailable();
        resource.state = "created";
        writeJsonAtomic(resourceFile, resource);
      } catch {
        await close();
        throw unavailable();
      }
      const spawnHosted = (config: SpawnOptions): SpawnedProcess => {
        const home = join(runDir, "runtime-home");
        mkdirSync(home, { recursive: true, mode: 0o700 });
        // A run may not import its real host HOME or any platform environment.
        const env = {
          ...config.env,
          HOME: kind === "claude_code" ? (config.env.HOME ?? home) : home,
          PATH: "/usr/local/bin:/usr/bin:/bin",
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
              (key === "CLAUDE_CODE_OAUTH_TOKEN" && value !== placeholder))
          )
            throw unavailable();
        const child = spawn("docker", ["start", "-ai", name], {
          env: bareEnv,
          stdio: ["pipe", "pipe", "pipe"],
          signal: config.signal,
        });
        child.stdin.write(
          JSON.stringify({ kind, args: config.args, cwd, env }) + "\n",
        );
        return child;
      };
      const codexSpawn: typeof spawnCli = async (_sandbox, argv, input) => {
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
        const adapter =
          kind === "codex"
            ? new CodexAdapter({
                stateDir: host.stateDir,
                sandbox: blockedSandbox,
                spawnCli: codexSpawn,
                onHostedSession: record,
                subscriptionAuth: {
                  accountId: first.accountId,
                  verify: async () => {
                    await check();
                  },
                  token: async () => {
                    const current = await check();
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
                spawnHosted: (config, token) => {
                  if (token !== placeholder) throw unavailable();
                  return spawnHosted(config);
                },
                subscriptionAuth: {
                  brokered: true,
                  accountId: first.accountId,
                  verify: async () => {
                    await check();
                  },
                  token: async () => {
                    const current = await check();
                    return {
                      accessToken: placeholder,
                      accountId: current.accountId,
                      expiresAt: current.expiresAt,
                    };
                  },
                },
              });
        const session = previous
          ? await adapter.resume(previous.sessionId, options)
          : await adapter.start(options);
        let checking = false;
        const timer = setInterval(() => {
          if (checking || closed) return;
          checking = true;
          void check()
            .catch(async () => {
              await session.cancel();
              await close();
            })
            .finally(() => {
              checking = false;
            })
            .catch(() => undefined);
        }, 1000);
        timer.unref();
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
            await session.send(text);
          },
          cancel: async () => {
            await session.cancel();
            await finish();
          },
        };
      } catch {
        await close();
        throw unavailable();
      }
    },
  };
}
