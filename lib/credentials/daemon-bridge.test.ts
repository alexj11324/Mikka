import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID, randomBytes } from "node:crypto";
import {
  registerCredentialBridge,
  credentialBridgeFor,
  closeCredentialBridges,
} from "../../packages/daemon/src/agents/credential-bridge";
import {
  RunContext,
  runPaths,
} from "../../packages/daemon/src/agents/run-context";

test("actual harness MCP spec keeps handoff tools and forwards only run-scoped credential tools without platform tokens", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "mikka-credential-daemon-test-"),
  );
  const repository = join(directory, "repo"),
    state = join(directory, "adapters");
  await mkdir(repository);
  await mkdir(state);
  execFileSync("git", ["init", "-q", repository]);
  const runId = randomUUID(),
    reference = randomUUID(),
    token = `mkw_${randomBytes(32).toString("hex")}`;
  let live = true,
    calls = 0,
    backendRequests = 0,
    initializationAttempts = 0;
  const backend = createServer(async (req, res) => {
    backendRequests++;
    assert.ok(
      req.headers.authorization === `Bearer ${token}`,
      "Daemon must authenticate privately to backend",
    );
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.method === 'initialize' && ++initializationAttempts === 1) { res.writeHead(503); res.end('{}'); return; }
    res.setHeader("content-type", "application/json");
    if (input.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown = {};
    if (input.method === "tools/list")
      result = {
        tools: [
          {
            name: "credential_status",
            description: "Status only",
            inputSchema: {
              type: "object",
              properties: { credentialRef: { type: "string" } },
            },
          },
          {
            name: "unrelated_platform_admin_tool",
            inputSchema: { type: "object" },
          },
        ],
      };
    if (input.method === "tools/call") {
      calls++;
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ state: "ready", credentialRef: reference }),
          },
        ],
      };
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const port = (backend.address() as { port: number }).port;
  await registerCredentialBridge({
    privateDir: directory,
    runId,
    mcp: { url: `http://127.0.0.1:${port}/mcp`, token },
    isLive: () => live,
  });
  const paths = runPaths(state, runId);
  await mkdir(paths.runDir, { recursive: true });
  const context = new RunContext({
    harness: "codex",
    worktree: repository,
    privateDir: directory,
    runDir: paths.runDir,
  });
  const spec = context.mcpServer();
  assert.ok(
    !JSON.stringify(spec).includes(token),
    "Platform token must not reach CLI argv/env",
  );
  const bridge = credentialBridgeFor(directory, runId)!;
  assert.ok(
    context.policy().allowDomains.includes(new URL(bridge).host),
    "Sandbox must permit only its exact local bridge host/port",
  );
  const child = spawn(spec.command, spec.args, {
    env: { NODE_ENV: "test", PATH: process.env.PATH, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map<number, (value: unknown) => void>();
  const output: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    output.push(line);
    const value = JSON.parse(line);
    responses.get(value.id)?.(value);
  });
  let seq = 0;
  const rpc = (method: string, params = {}) =>
    new Promise<{
      result: {
        tools?: { name: string }[];
        content?: { text: string }[];
        isError?: boolean;
      };
    }>((resolve, reject) => {
      const id = ++seq,
        timeout = setTimeout(
          () => reject(new Error("Harness MCP timed out")),
          5000,
        );
      responses.set(id, (value) => {
        clearTimeout(timeout);
        resolve(value as never);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    await rpc("initialize", { protocolVersion: "2025-03-26" });
    const listed = await rpc("tools/list");
    assert.equal(
      backendRequests,
      0,
      "Local tool discovery must never wait for the backend",
    );
    for (const name of [
      "submit",
      "ask_human",
      "report_blocked",
      "credential_status",
    ])
      assert.ok(listed.result.tools?.some((tool) => tool.name === name));
    assert.ok(
      !listed.result.tools?.some(
        (tool) => tool.name === "unrelated_platform_admin_tool",
      ),
    );
    const failed = await rpc("tools/call", {
      name: "credential_status",
      arguments: { credentialRef: reference },
    });
    assert.equal(failed.result.isError, true);
    assert.equal(calls, 0);
    const reply = await rpc("tools/call", {
      name: "credential_status",
      arguments: { credentialRef: reference },
    });
    assert.equal(
      JSON.parse(reply.result.content![0].text).credentialRef,
      reference,
    );
    assert.equal(initializationAttempts, 2, 'Transient initialization failure must recover without daemon restart');
    const before = calls;
    const denied = await rpc("tools/call", {
      name: "credential_status",
      arguments: { credentialRef: reference, runId: randomUUID() },
    });
    assert.equal(denied.result.isError, true);
    assert.equal(calls, before);
    live = false;
    const stopped = await rpc("tools/call", {
      name: "credential_status",
      arguments: { credentialRef: reference },
    });
    assert.equal(stopped.result.isError, true);
    assert.equal(calls, before);
    assert.ok(
      !output.join("").includes(token),
      "Platform token must not reach MCP output",
    );
  } finally {
    child.stdin.end();
    child.kill();
    await once(child, "close");
    await closeCredentialBridges(directory);
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
