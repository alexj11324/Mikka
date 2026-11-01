// Private hosted-run bootstrap. The first stdin frame is host configuration;
// later bytes are the existing CLI protocol. No vault/provider token is accepted.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync } from "node:fs";
import { startNativeEgress } from "./native-egress.mjs";

const PLACEHOLDER = "mikka-native-broker-placeholder";
const fail = () => {
  process.stderr.write("native_runtime_unavailable\n");
  process.exit(1);
};
let initial = Buffer.alloc(0);
let starting = false;
process.stdin.on("data", onData);
function onData(part) {
  if (starting) return;
  initial = Buffer.concat([initial, part]);
  const newline = initial.indexOf(10);
  if (newline < 0) {
    if (initial.length > 131072) fail();
    return;
  }
  starting = true;
  process.stdin.pause();
  process.stdin.removeListener("data", onData);
  let config;
  try {
    config = JSON.parse(initial.subarray(0, newline).toString("utf8"));
  } catch {
    fail();
  }
  const remainder = initial.subarray(newline + 1);
  initial = Buffer.alloc(0);
  void start(config, remainder).catch(fail);
}
async function start(config, remainder) {
  if (
    !["claude_code", "codex"].includes(config.kind) ||
    !Array.isArray(config.args) ||
    !config.args.every((a) => typeof a === "string") ||
    typeof config.cwd !== "string" ||
    !config.env ||
    typeof config.env !== "object"
  )
    fail();
  for (const [key, value] of Object.entries(config.env)) {
    if (
      typeof value !== "string" ||
      /INFISICAL|E2B_API_KEY|REFRESH_TOKEN|^AWS_|^GOOGLE_|^OPENAI_|^ANTHROPIC_.*(?:KEY|TOKEN)|SECRET|PASSWORD/.test(
        key,
      )
    )
      fail();
    if ((key === "CLAUDE_CODE_OAUTH_TOKEN" || key === "MIKKA_MODEL_API_KEY") && value !== PLACEHOLDER) fail();
  }
  delete config.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (config.githubBin !== undefined && (typeof config.githubBin !== 'string' || !config.githubBin.startsWith('/') || !config.githubBin.endsWith('/github/bin') || config.githubBin.includes(':') || config.githubBin.includes('\n'))) fail();
  config.env.PATH = `${config.githubBin ? config.githubBin + ':' : ''}/usr/local/bin:/usr/bin:/bin`;
  mkdirSync(config.env.HOME, { recursive: true, mode: 0o700 });
  // Model credentials stay on the original task broker. Public downloads use
  // a separate live, public-IP-only host proxy, never that credential endpoint.
  const egress = config.publicEgress === true ? await startNativeEgress() : null;
  if (egress) {
    Object.assign(config.env, {
      HTTP_PROXY: egress.url, HTTPS_PROXY: egress.url,
      http_proxy: egress.url, https_proxy: egress.url,
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
      NODE_USE_ENV_PROXY: '1',
    });
  }
  // The model transport remains bound to the mounted task broker socket.
  const proxy = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let path = request.url;
    if (config.kind === "codex" && path.endsWith("/responses"))
      path = "/responses";
    const upstream = httpRequest(
      {
        socketPath: "/run/mikka-native.sock",
        method: "POST",
        path,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode, {
          "content-type": result.headers["content-type"] ?? "application/json",
        });
        result.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
    response.on("close", () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const args = [...config.args];
  if (config.kind === "claude_code") {
    config.env.ANTHROPIC_BASE_URL = base;
    config.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3";
    // Docker confines all tools here; never request a privileged nested sandbox.
    const settingsIndex = args.findIndex(
      (value) => value === "--settings" || value.startsWith("--settings="),
    );
    if (settingsIndex < 0) fail();
    const inline = args[settingsIndex].startsWith("--settings=");
    const settings = JSON.parse(
      inline
        ? args[settingsIndex].slice("--settings=".length)
        : args[settingsIndex + 1],
    );
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      fail();
    settings.sandbox = { ...settings.sandbox, enabled: false };
    if (inline) args[settingsIndex] = "--settings=" + JSON.stringify(settings);
    else args[settingsIndex + 1] = JSON.stringify(settings);
    for (let i = 0; i < args.length; i++)
      if (args[i] === "--mcp-config" && args[i + 1]) {
        const value = JSON.parse(args[i + 1]);
        if (value.mcpServers?.mikka)
          value.mcpServers.mikka.command = "/usr/local/bin/node";
        args[i + 1] = JSON.stringify(value);
      }
  } else {
    // An API-key run names its provider; its requests also go to the task broker, which adds the key.
    for (let i = 0; i < args.length; i++)
      if (args[i].startsWith("model_providers.mikka.base_url=")) args[i] = `model_providers.mikka.base_url=${JSON.stringify(base)}`;
    args.push(
      "-c",
      `chatgpt_base_url=${JSON.stringify(base + "/backend-api/")}`,
    );
    args.push(
      "-c",
      "model_providers.openai.supports_websockets=false",
      "-c",
      "features.responses_websockets=false",
      "-c",
      "features.responses_websockets_v2=false",
    );
    args.push("-c", 'mcp_servers.mikka.command="/usr/local/bin/node"');
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_TERMINAL_PROMPT",
      'PATH', 'GH_HOST', 'GH_REPO', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      ...Object.keys(config.env).filter(key => /^GIT_CONFIG_(?:COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/.test(key)),
      "HOME",
      ...(egress ? ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"] : []),
    ])
      if (config.env[key] !== undefined) args.push(
        "-c",
        `shell_environment_policy.set.${key}=${JSON.stringify(config.env[key])}`,
      );
  }
  const child = spawn("/usr/local/bin/native-cli", args, {
    cwd: config.cwd,
    env: config.env,
    stdio:
      config.kind === "claude_code"
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
  });
  if (config.kind === "claude_code") {
    child.stdio[3].on("error", () => child.kill("SIGTERM"));
    child.stdio[3].end(PLACEHOLDER);
  }
  // Raw native diagnostics can echo model data: never publish stderr.
  child.stderr.resume();
  child.stdout.pipe(process.stdout);
  if (remainder.length) child.stdin.write(remainder);
  process.stdin.pipe(child.stdin);
  process.stdin.resume();
  child.stdin.on("error", () => undefined);
  let timer;
  const stop = () => {
    child.kill("SIGTERM");
    timer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdin.on("end", () => {
    child.stdin.end();
    timer ??= setTimeout(stop, 3000);
  });
  child.on("error", fail);
  child.on("exit", (code) => {
    clearTimeout(timer);
    proxy.closeAllConnections();
    void (egress?.close() ?? Promise.resolve()).finally(() => proxy.close(() => process.exit(code ?? 1)));
  });
}
