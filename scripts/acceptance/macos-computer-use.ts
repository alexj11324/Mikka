// Scripted macOS acceptance for local computer use. Linux CI does not run
// this: it needs a real Mac, the pinned 0.38.0 driver and TCC grants.
//
//   node scripts/acceptance/macos-computer-use.ts
//
// Every action goes through the real request-only proxy -> broker -> driver.
// Evidence lands in artifacts/macos-computer/<run>/ (gitignored): a JSON
// report and PNGs. The report never carries screen content, only sizes and
// hashes. Exit codes: 0 passed or skipped (not macOS), 1 failed, 2 blocked
// (driver or permissions missing).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ComputerBroker } from "../../packages/daemon/src/computer/broker.mjs";
import { detectComputerDriver, readComputerPermissions } from "../../packages/daemon/src/computer/driver.mjs";
import { doctorComputerDriver } from "../../packages/daemon/src/computer/doctor.mjs";
import type { ComputerDriver } from "../../packages/daemon/src/computer/driver.mjs";
import { compileFixture, fixtureFile, startFixture, waitExit, waitFile, type Fixture } from "../../packages/daemon/test/macos-fixture.ts";

const startedAt = new Date().toISOString();
const runName = startedAt.replace(/[:.]/g, "-");
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidenceDir = process.env.MIKKA_CUA_EVIDENCE_DIR ?? join(root, "artifacts", "macos-computer", runName);
const marker = `Mikka acceptance ${randomUUID()}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface ActionEvidence {
  action: string;
  request: Record<string, unknown>;
  elapsedMs: number;
  before?: string;
  after?: string;
  details: Record<string, unknown>;
}

async function saveEvidence(value: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "evidence.json"), JSON.stringify(value, null, 2));
}

function imageOf(result: any): Buffer {
  const image = Array.isArray(result?.content)
    ? result.content.find((part: any) => part?.type === "image" && typeof part.data === "string")
    : undefined;
  assert.ok(image, "driver returned an image");
  const bytes = Buffer.from(image.data, "base64");
  assert.ok(bytes.length > 0, "image data is decodable");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "image is a PNG");
  return bytes;
}

function dimensions(result: any): { width: number; height: number } {
  const width = result?.structuredContent?.screenshot_width;
  const height = result?.structuredContent?.screenshot_height;
  assert.ok(Number.isInteger(width) && width > 0, "screenshot width is positive");
  assert.ok(Number.isInteger(height) && height > 0, "screenshot height is positive");
  return { width, height };
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ProxyClient {
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  kill(): void;
}

function startProxy(grant: { socketPath: string; token: string }): ProxyClient {
  const proxyPath = fileURLToPath(new URL("../../packages/daemon/src/computer/proxy.mjs", import.meta.url));
  const child = spawn(process.execPath, [proxyPath, grant.socketPath, grant.token], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error("proxy error")) : waiter.resolve(message.result);
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("proxy exited"));
    pending.clear();
  });
  let next = 0;
  return {
    call(name, args = {}) {
      return new Promise((resolveCall, rejectCall) => {
        const id = `acceptance-${++next}`;
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
      });
    },
    kill() {
      child.stdin.end();
      child.kill();
    },
  };
}

/** One direct MCP call for fixture-side checks only (never for the four actions). */
function directTool(driver: ComputerDriver, name: string, args: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(driver.path, ["mcp", "--direct"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const pending = new Map<string, (value: any) => void>();
    let next = 0;
    const finish = (error?: Error, value?: any) => {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* exited */ }
      child.kill();
      error ? rejectCall(error) : resolveCall(value);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return finish(new Error("invalid driver response")); }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? finish(new Error("driver rejected the check")) : waiter(message.result);
    });
    child.on("error", () => finish(new Error("driver did not start")));
    child.on("exit", () => finish(new Error("driver exited before answering")));
    const request = (method: string, params: Record<string, unknown>) =>
      new Promise<any>((resolveRequest) => {
        const id = `direct-${++next}`;
        pending.set(id, resolveRequest);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    const timer = setTimeout(() => finish(new Error("driver check timed out")), timeoutMs);
    void (async () => {
      try {
        await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mikka-acceptance", version: "1" } });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        finish(undefined, await request("tools/call", { name, arguments: args }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("driver check failed"));
      }
    })();
  });
}

async function main(): Promise<number> {
  if (process.platform !== "darwin") {
    console.log(JSON.stringify({ status: "skipped", reason: "macOS only" }));
    return 0;
  }
  const binary = process.env.MIKKA_CUA_TEST_BINARY ?? process.env.MIKKA_CUA_DRIVER;
  const driver = await detectComputerDriver(binary);
  if (!driver) {
    const doctor = await doctorComputerDriver({ binary });
    await saveEvidence({ status: "blocked", reason: "cua-driver 0.38.0 is not installed", driver: null, doctor, startedAt });
    console.error(`blocked: cua-driver 0.38.0 is not installed; evidence in ${evidenceDir}`);
    return 2;
  }
  const permissions = await readComputerPermissions(driver);
  const doctor = await doctorComputerDriver({ binary });
  if (doctor.probe.status !== "ok") {
    await saveEvidence({ status: "blocked", reason: `driver health: ${doctor.probe.status}`, driver, permissions, doctor, startedAt });
    console.error(`blocked: ${doctor.probe.status}; click 启用本机电脑操作 in 设置 › 设备 first; evidence in ${evidenceDir}`);
    return 2;
  }

  const dir = await mkdtemp(join(tmpdir(), "mikka-acceptance-"));
  const evidence: {
    status: string;
    startedAt: string;
    finishedAt?: string;
    platform: string;
    marker: string;
    driver: ComputerDriver;
    permissions: unknown;
    doctor: unknown;
    screen: { width: number; height: number; scale: number };
    actions: ActionEvidence[];
    assertions: Record<string, boolean>;
    artifacts: string[];
  } = {
    status: "running",
    startedAt,
    platform: process.platform,
    marker,
    driver,
    permissions,
    doctor,
    screen: { width: 0, height: 0, scale: 0 },
    actions: [],
    assertions: {},
    artifacts: [],
  };
  const broker = new ComputerBroker({ driver, socketPath: join(dir, "broker.sock"), transport: "tcp", permitted: () => true });
  let fixture: Fixture | null = null;
  try {
    const fixtureBinary = await compileFixture(dir);
    await broker.listen();

    // The screen size check compares logical points x backing scale with the
    // screenshot pixels; it is fixture-side, not one of the four actions.
    const screenResult = await directTool(driver, "get_screen_size", {});
    const screen = screenResult?.structuredContent;
    assert.ok(Number.isInteger(screen?.width) && screen.width > 0, "logical screen width");
    assert.ok(Number.isInteger(screen?.height) && screen.height > 0, "logical screen height");
    assert.ok(Number.isInteger(screen?.scale_factor) && screen.scale_factor > 0, "backing scale factor");
    evidence.screen = { width: screen.width, height: screen.height, scale: screen.scale_factor };

    // Allow: no approval is ever created for any of the four actions.
    const allow = broker.spec("acceptance-allow", "allow");
    assert.ok(allow, "allow grant");
    const client = startProxy(allow);

    const capture = async (name: string) => {
      const began = performance.now();
      const result = await client.call("get_desktop_state");
      assert.notEqual(result?.isError, true, `screenshot failed: ${name}`);
      assert.equal(broker.list().length, 0, "allow must not create an approval");
      const bytes = imageOf(result);
      const { width, height } = dimensions(result);
      assert.equal(width, evidence.screen.width * evidence.screen.scale, "screenshot width matches logical size x scale");
      assert.equal(height, evidence.screen.height * evidence.screen.scale, "screenshot height matches logical size x scale");
      const file = join(evidenceDir, `${name}.png`);
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(file, bytes);
      evidence.artifacts.push(file);
      return { bytes, width, height, elapsedMs: performance.now() - began, file };
    };

    // Scroll fixture stays alive: it hosts the two consecutive screenshots,
    // the scroll offset observation and the before/after pair.
    const scrollFixture = await startFixture(fixtureBinary, "scroll");
    fixture = scrollFixture;
    const first = await capture("screenshot-1");
    const second = await capture("screenshot-2");
    evidence.actions.push({
      action: "screenshot",
      request: { name: "get_desktop_state", arguments: {} },
      elapsedMs: first.elapsedMs + second.elapsedMs,
      before: first.file,
      after: second.file,
      details: { width: first.width, height: first.height, firstHash: digest(first.bytes), secondHash: digest(second.bytes) },
    });

    const scrollBegan = performance.now();
    const scrollResult = await client.call("scroll", { direction: "down", amount: 5, x: scrollFixture.points.scroll.x, y: scrollFixture.points.scroll.y });
    assert.notEqual(scrollResult?.isError, true, "scroll failed");
    assert.equal(broker.list().length, 0, "allow must not create an approval");
    const offset = Number(await waitFile(fixtureFile(scrollFixture, "scroll")));
    assert.ok(Number.isInteger(offset) && offset > 0, "scroll changed the fixture's content offset");
    const afterScroll = await capture("scroll-after");
    assert.notEqual(digest(afterScroll.bytes), digest(first.bytes), "scroll changed the screen");
    evidence.actions.push({
      action: "scroll",
      request: { name: "scroll", arguments: { direction: "down", amount: 5, x: scrollFixture.points.scroll.x, y: scrollFixture.points.scroll.y } },
      elapsedMs: performance.now() - scrollBegan,
      before: first.file,
      after: afterScroll.file,
      details: { offset, beforeHash: digest(first.bytes), afterHash: digest(afterScroll.bytes) },
    });
    scrollFixture.child.kill();
    fixture = null;

    // Click: the fixture writes on the real button action and exits 0.
    const clickFixture = await startFixture(fixtureBinary, "click");
    fixture = clickFixture;
    const beforeClick = await capture("click-before");
    const clickBegan = performance.now();
    const clickResult = await client.call("click", clickFixture.points.button);
    assert.notEqual(clickResult?.isError, true, "click failed");
    assert.equal(broker.list().length, 0, "allow must not create an approval");
    assert.equal(await waitExit(clickFixture.child), 0, "the fixture's button action ran");
    assert.equal(await readFile(fixtureFile(clickFixture, "click"), "utf8"), "clicked");
    const afterClick = await capture("click-after");
    assert.notEqual(digest(afterClick.bytes), digest(beforeClick.bytes), "click changed the screen");
    evidence.actions.push({
      action: "click",
      request: { name: "click", arguments: clickFixture.points.button },
      elapsedMs: performance.now() - clickBegan,
      before: beforeClick.file,
      after: afterClick.file,
      details: { exitCode: 0, beforeHash: digest(beforeClick.bytes), afterHash: digest(afterClick.bytes) },
    });
    fixture = null;

    // Type: the fixture focuses an NSTextField; enter must deliver the exact
    // marker, which also proves the enter -> return mapping.
    const typeFixture = await startFixture(fixtureBinary, "type");
    fixture = typeFixture;
    const beforeType = await capture("type-before");
    const typeBegan = performance.now();
    const typeResult = await client.call("type_text", { text: marker });
    assert.notEqual(typeResult?.isError, true, "type_text failed");
    const enterResult = await client.call("press_key", { key: "enter" });
    assert.notEqual(enterResult?.isError, true, "press_key enter failed");
    assert.equal(broker.list().length, 0, "allow must not create an approval");
    assert.equal(await waitExit(typeFixture.child), 0, "the fixture's text field action ran on enter");
    assert.equal(await readFile(fixtureFile(typeFixture, "type"), "utf8"), marker, "the application received exactly the marker");
    const afterType = await capture("type-after");
    assert.notEqual(digest(afterType.bytes), digest(beforeType.bytes), "typing changed the screen");
    evidence.actions.push({
      action: "type",
      request: { name: "type_text", arguments: { text: marker } },
      elapsedMs: performance.now() - typeBegan,
      before: beforeType.file,
      after: afterType.file,
      details: { enter: "return", exitCode: 0, beforeHash: digest(beforeType.bytes), afterHash: digest(afterType.bytes) },
    });
    fixture = null;
    client.kill();

    // Ask: one pending review, no replay, and the model gets no result.
    const ask = broker.spec("acceptance-ask", "ask");
    assert.ok(ask, "ask grant");
    const askClient = startProxy(ask);
    const pendingCall = askClient.call("get_desktop_state");
    let requests: any[] = [];
    for (let i = 0; i < 100 && requests.length === 0; i++) {
      await sleep(20);
      requests = broker.list();
    }
    assert.equal(requests.length, 1, "ask creates exactly one pending review");
    assert.equal(requests[0].runId, "acceptance-ask");
    assert.match(requests[0].digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(await broker.decide(requests[0].id, requests[0].digest, false), { ok: true });
    const refused = await pendingCall;
    assert.equal(refused?.isError, true, "a denied review returns no desktop content");
    await assert.rejects(async () => broker.decide(requests[0].id, requests[0].digest, true), /expired|already consumed/);
    assert.equal(broker.list().length, 0, "the review is consumed");
    askClient.kill();
    evidence.assertions = {
      allowNeverReviewed: true,
      askCreatedOnePending: true,
      askReplayRefused: true,
      allowNoPendingAfterAllActions: true,
    };
    evidence.status = "passed";
    evidence.finishedAt = new Date().toISOString();
    await saveEvidence(evidence);
    console.log(JSON.stringify({ status: "passed", evidence: join(evidenceDir, "evidence.json"), actions: evidence.actions.length }));
    return 0;
  } catch (error) {
    fixture?.child.kill();
    evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    // Driver version and doctor only; never screen content or driver stderr.
    await saveEvidence({ ...evidence, failure: error instanceof Error ? error.message : "acceptance failed" });
    console.error(`failed: ${error instanceof Error ? error.message : "acceptance failed"}; evidence in ${evidenceDir}`);
    return 1;
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), async (error) => {
  console.error(`failed: ${error instanceof Error ? error.message : "acceptance failed"}`);
  process.exit(1);
});
