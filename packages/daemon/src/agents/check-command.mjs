// A host-advertised Factory capability. Native shell tools remain disabled for
// read-only sessions. This uses the same fixed-HEAD/no-mutation contract as the
// daemon's final verification, and never inherits model/provider credentials.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export function createCheckCommand(config) {
  const worktree = realpathSync(config.worktree);
  const gitDir = realpathSync(config.gitDir);
  if (
    !/^[a-f0-9]{40}$/.test(config.candidateSha) ||
    (typeof config.command !== "string" && config.infer !== true)
  )
    throw new Error("Invalid host check binding");
  const env = { HOME: dirname(config.file ?? gitDir) };
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  const git = (args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      {
        cwd: worktree,
        env: { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: worktree },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const snapshot = () => {
    if (
      git(["rev-parse", "HEAD"]) !== config.candidateSha ||
      git(["status", "--porcelain"])
    )
      throw new Error("Check requires the unchanged fixed candidate");
    return git(["rev-parse", "HEAD^{tree}"]);
  };
  const source = (path) => {
    try {
      const resolved = realpathSync(join(worktree, path));
      if (!resolved.startsWith(worktree + sep)) return "";
      const observed = readFileSync(resolved, "utf8");
      const declared = git(["show", `${config.candidateSha}:${path}`]);
      return observed.length <= 256000 && observed.trim() === declared
        ? observed
        : "";
    } catch {
      return "";
    }
  };
  const infer = (command) => {
    const script = /^(npm|pnpm|yarn|bun) (?:run )?([\w:.-]+)$/.exec(command);
    if (script) {
      try {
        if (
          typeof JSON.parse(source("package.json")).scripts?.[script[2]] ===
          "string"
        )
          return `package.json scripts.${script[2]}`;
      } catch {}
    }
    const make = /^make ([\w.-]+)$/.exec(command);
    if (make)
      for (const file of ["Makefile", "makefile", "GNUmakefile"])
        if (
          new RegExp(`^${make[1].replaceAll(".", "\\.")}\\s*:`, "m").test(
            source(file),
          )
        )
          return `${file} target ${make[1]}`;
    let workflows = [];
    try {
      workflows = readdirSync(join(worktree, ".github/workflows"))
        .filter((file) => /\.ya?ml$/.test(file))
        .slice(0, 30);
    } catch {}
    for (const file of workflows)
      if (
        source(`.github/workflows/${file}`)
          .split("\n")
          .some(
            (line) =>
              line.trim() === command ||
              line
                .trim()
                .replace(/^-?\s*run:\s*/, "")
                .replace(/^['"]|['"]$/g, "") === command,
          )
      )
        return `.github/workflows/${file}`;
    return null;
  };
  const active = new Set();
  const stop = (child) => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 1000);
    timer.unref();
  };
  return {
    tool: {
      name: "verify_command",
      description:
        "Run the host-bound verification command against this fixed candidate and return actual exit/output evidence. Native Bash stays unavailable. With no frozen command, choose a declared package script, Makefile target or CI command and name its source. This does not finish the run.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          basis: {
            type: "string",
            description:
              "Repository file/script used to infer the command, if it was not frozen.",
          },
        },
        required: ["command"],
      },
    },
    close() {
      for (const child of active) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    },
    async execute(args) {
      try {
        const command =
          typeof args.command === "string" ? args.command.trim() : "";
        if (!command || command.length > 4000 || /[\0]/.test(command))
          throw new Error("Invalid verification command");
        const basis = config.command
          ? "Frozen repository verification command"
          : typeof args.basis === "string" && args.basis.trim()
            ? infer(command)
            : null;
        if (config.command ? command !== config.command : !basis)
          throw new Error(
            "Use the frozen command or a declared repository verification entrypoint",
          );
        const before = snapshot();
        const result = await new Promise((resolve, reject) => {
          const child = spawn("/bin/sh", ["-c", command], {
            cwd: worktree,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          active.add(child);
          let output = "",
            timedOut = false;
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          const collect = (data) => {
            output = (output + data).slice(-16000);
          };
          child.stdout.on("data", collect);
          child.stderr.on("data", collect);
          const timer = setTimeout(
            () => {
              timedOut = true;
              stop(child);
            },
            Math.min(Math.max(config.timeoutMs ?? 1800000, 100), 1800000),
          );
          child.once("error", (error) => {
            clearTimeout(timer);
            active.delete(child);
            reject(error);
          });
          child.once("close", (exitCode, signal) => {
            clearTimeout(timer);
            active.delete(child);
            resolve({ exitCode, signal, timedOut, output });
          });
        });
        if (snapshot() !== before)
          throw new Error("Verification changed the fixed candidate");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                executed: true,
                command,
                basis,
                sha: config.candidateSha,
                readOnly: true,
                ...result,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Verification unavailable",
            },
          ],
        };
      }
    },
  };
}
