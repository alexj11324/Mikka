// Network-disabled native runtime. Only this task's Unix socket is mounted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const home = "/tmp/owner";
const worktree = "/tmp/project";
mkdirSync(home, { recursive: true });
mkdirSync(worktree);
writeFileSync(
  join(home, ".claude.json"),
  JSON.stringify({ hasCompletedOnboarding: true }),
);
const placeholder = "mikka-broker-placeholder-not-a-provider-credential";
const base = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  BROKER_HOST_PID: process.env.BROKER_HOST_PID,
};
async function cli(args, extra = {}) {
  const child = spawn("/usr/local/bin/claude", args, {
    cwd: worktree,
    env: { ...base, ...extra },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (value) => {
    stdout += value;
  });
  child.stderr.resume();
  child.stdio[3].on("error", () => undefined);
  child.stdio[3].end(placeholder);
  assert.equal(
    readFileSync(`/proc/${child.pid}/environ`).includes(placeholder),
    false,
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const code = await new Promise((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  clearTimeout(timer);
  assert.equal(stdout.includes(placeholder), false);
  return { code, stdout };
}
const status = await cli(["auth", "status", "--json"]);
assert.equal(status.code, 0);
assert.equal(JSON.parse(status.stdout).authMethod, "oauth_token");
assert.equal(JSON.parse(status.stdout).loggedIn, true);
const server = createServer((request, response) => {
  const upstream = httpRequest(
    {
      socketPath: "/run/native-broker.sock",
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (result) => {
      response.writeHead(result.statusCode, {
        "content-type": result.headers["content-type"],
      });
      result.pipe(response);
    },
  );
  upstream.on("error", () => response.destroy());
  request.pipe(upstream);
  response.on("close", () => upstream.destroy());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const run = await cli(
    [
      "-p",
      "Perform the one offline tool probe.",
      "--output-format",
      "json",
      "--model",
      "synthetic-offline-model",
      "--max-turns",
      "2",
      "--dangerously-skip-permissions",
      "--tools",
      "Bash",
      "--settings",
      JSON.stringify({ sandbox: { enabled: false } }),
    ],
    { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
  );
  assert.equal(
    run.code,
    0,
    "official CLI did not finish the offline tool turn",
  );
  function scan(path) {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      const stat = statSync(file);
      if (stat.isDirectory()) scan(file);
      else if (stat.isFile() && stat.size < 2_000_000)
        assert.equal(readFileSync(file).includes("provider-secret-"), false);
    }
  }
  scan(home);
  scan(worktree);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
