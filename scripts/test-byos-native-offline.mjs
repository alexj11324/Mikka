// Official installed CLI, external synthetic credential custody, no external network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeSubscriptionBroker } from "../packages/daemon/src/subscription-native-broker.ts";

if (process.platform !== "linux") throw new Error("Cloud Linux required");
const require = createRequire(
  new URL("../packages/daemon/package.json", import.meta.url),
);
const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
const binary = join(
  dirname(sdk.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")),
  "claude",
);
const fixture = fileURLToPath(
  new URL("../tests/fixtures/byos-native-claude-offline.mjs", import.meta.url),
);
const name = `mikka-byos-native-offline-${randomUUID()}`;
const root = mkdtempSync(join(tmpdir(), "mikka-native-broker-"));
// This unpredictable synthetic value exists only in the host-side fake worker/provider.
const providerToken = `provider-secret-${randomBytes(24).toString("hex")}`;
let calls = 0;
let toolResult = null;
let connected = true;
const shellProbe = `node -e 'const fs=require("fs");const e=process.env;let parentMemoryReadable=false;try{const fd=fs.openSync("/proc/"+process.ppid+"/mem","r");fs.closeSync(fd);parentMemoryReadable=true}catch{};let custodyMemoryVisible=false;try{fs.openSync("/proc/"+e.BROKER_HOST_PID+"/mem","r");custodyMemoryVisible=true}catch{};console.log(JSON.stringify({providerTokenInEnvironment:Object.hasOwn(e,"CLAUDE_CODE_OAUTH_TOKEN"),platformKeyInEnvironment:Object.keys(e).some(k=>/INFISICAL|E2B_API_KEY|REFRESH_TOKEN/.test(k)),parentMemoryReadable,custodyMemoryVisible}))'`;
const provider = createServer(async (request, response) => {
  assert.ok(request.headers.authorization === `Bearer ${providerToken}`);
  calls++;
  assert.ok(calls <= 4);
  let raw = "";
  for await (const part of request) {
    raw += part;
    assert.ok(raw.length <= 2_000_000);
  }
  assert.ok(!raw.includes(providerToken));
  const body = JSON.parse(raw);
  const result = body.messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find((block) => block.type === "tool_result");
  if (result) toolResult = result.content;
  const block = result
    ? { type: "text", text: "offline complete" }
    : {
        type: "tool_use",
        id: "offline-tool",
        name: "Bash",
        input: {
          command: shellProbe,
          description: "Offline credential boundary probe",
        },
      };
  if (!body.stream) {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          id: "offline",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [block],
          stop_reason: result ? "end_turn" : "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, fields) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
    );
  event("message_start", {
    message: {
      id: `offline-${calls}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  event("content_block_start", {
    index: 0,
    content_block:
      block.type === "text"
        ? { type: "text", text: "" }
        : { ...block, input: {} },
  });
  event("content_block_delta", {
    index: 0,
    delta:
      block.type === "text"
        ? { type: "text_delta", text: block.text }
        : {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
  });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: {
      stop_reason: result ? "end_turn" : "tool_use",
      stop_sequence: null,
    },
    usage: { output_tokens: 1 },
  });
  event("message_stop", {});
  response.end();
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const broker = await createNativeSubscriptionBroker({
  root,
  revision: 2,
  check: async () => {
    if (!connected) throw new Error("disconnected");
  },
  worker: {
    async nativeRequest(revision, payload, signal) {
      assert.equal(revision, 2);
      assert.ok(
        payload.path === "/v1/messages" ||
          payload.path === "/v1/messages?beta=true",
      );
      assert.equal(payload.body.model, "synthetic-offline-model");
      const response = await fetch(
        `http://127.0.0.1:${provider.address().port}${payload.path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${providerToken}`,
          },
          body: JSON.stringify(payload.body),
          signal,
        },
      );
      return { contentType: "text/event-stream", body: response.body };
    },
  },
});
const run = (args, quiet = false) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { PATH: process.env.PATH },
      stdio: [
        "ignore",
        quiet ? "ignore" : "inherit",
        quiet ? "ignore" : "inherit",
      ],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Offline native probe timeout"));
    }, 90_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Offline native probe could not start"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Offline native probe exited ${code}`));
    });
  });
try {
  await run([
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--memory=1g",
    "--cpus=2",
    "--pids-limit=128",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=128m",
    "-v",
    `${binary}:/usr/local/bin/claude:ro`,
    "-v",
    `${fixture}:/probe.mjs:ro`,
    "-v",
    `${broker.socket}:/run/native-broker.sock:ro`,
    "-e",
    `BROKER_HOST_PID=${process.pid}`,
    "node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a",
    "node",
    "/probe.mjs",
  ]);
  const text =
    typeof toolResult === "string"
      ? toolResult
      : Array.isArray(toolResult)
        ? toolResult.map((block) => block.text ?? "").join("")
        : "";
  const result = JSON.parse(text.trim());
  assert.equal(result.providerTokenInEnvironment, false);
  assert.equal(result.platformKeyInEnvironment, false);
  assert.equal(result.custodyMemoryVisible, false);
  connected = false;
  const before = calls;
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath: broker.socket, method: "POST", path: "/v1/messages" },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(status, 503);
  assert.equal(calls, before);
  console.log(
    JSON.stringify({
      result: "pass",
      officialCLI: "Claude Code 2.1.305",
      network: "none",
      realCredentials: false,
      custody: "external host broker with synthetic provider",
      officialBashExecuted: true,
      providerTokenInEnvironment: false,
      platformKeyInEnvironment: false,
      custodyMemoryVisible: false,
      cliParentMemoryReadable: result.parentMemoryReadable,
      disconnectRefusedBeforeProvider: true,
      scope:
        "real CLI + synthetic provider; not real-provider or production acceptance",
    }),
  );
} finally {
  await run(["rm", "-f", name], true).catch(() => undefined);
  await broker.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
