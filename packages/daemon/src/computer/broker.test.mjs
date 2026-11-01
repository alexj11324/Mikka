import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ComputerBroker } from "./broker.mjs";
import { normalizeCall, detectComputerDriver, driverArguments } from "./driver.mjs";
const driver = {
  installed: true,
  path: "/test/driver",
  version: "cua-driver 0.38.0",
  fingerprint: "pinned-hash",
};
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mikka-computer-"));
  const broker = new ComputerBroker({
    driver,
    socketPath: join(dir, "socket"),
    permitted: () => true,
    execute: async (_, call) => ({
      content: [{ type: "text", text: JSON.stringify(call) }],
    }),
    ...overrides,
  });
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  return broker;
}
test("TCP grants require the actual listening endpoint", async (t) => {
  const broker = await fixture(t, { transport: "tcp" });
  assert.equal(broker.spec("run", "allow"), undefined);
  await broker.listen();
  const grant = broker.spec("run", "allow");
  assert.match(grant.socketPath, /^tcp:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.equal(grant.socketPath, broker.socketPath);
});
test("revoking a run grant promptly rejects pending work without revoking another run", async (t) => {
  let calls = 0;
  const b = await fixture(t, { execute: async () => { calls++; return 'ok'; } });
  const first = b.spec('first', 'ask');
  const second = b.spec('second', 'allow');
  const pending = b.request(first.token, { name: 'click', arguments: { x: 1, y: 2 } });
  assert.equal(b.list().length, 1);
  b.revoke(first.token);
  await assert.rejects(pending, /Run ended/);
  assert.equal(b.list().length, 0);
  await assert.rejects(b.request(first.token, { name: 'get_desktop_state' }), /Not permitted/);
  assert.equal(await b.request(second.token, { name: 'get_desktop_state' }), 'ok');
  assert.equal(calls, 1);
});
test("suspending revokes grants and pending reviews without closing resources", async (t) => {
  let calls = 0;
  const b = await fixture(t, { execute: async () => { calls++; } });
  const grant = b.spec("run", "ask");
  const pending = assert.rejects(b.request(grant.token, { name: "get_desktop_state" }));
  const row = b.list()[0];
  b.suspend();
  await pending;
  assert.deepEqual(b.list(), []);
  await assert.rejects(b.request(grant.token, { name: "get_desktop_state" }));
  await assert.rejects(() => b.decide(row.id, row.digest, true));
  assert.equal(b.spec("run", "allow"), undefined);
  await assert.rejects(() => b.listen(), /suspended/);
  assert.equal(calls, 0);
});
test("listen rejects a pre-existing path without deleting or replacing it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "broker-conflict-"));
  const socketPath = join(dir, "socket");
  await writeFile(socketPath, "retained evidence");
  const b = await fixture(t, { socketPath });
  await assert.rejects(() => b.listen(), { code: "EADDRINUSE" });
  assert.equal(await readFile(socketPath, "utf8"), "retained evidence");
  await b.close();
  assert.equal(await readFile(socketPath, "utf8"), "retained evidence");
  t.after(() => rm(dir, { recursive: true, force: true }));
});
for (const permission of ["allow", "ask"]) test(`suspension during ${permission} asynchronous admission blocks the later action`, async (t) => {
  let release, called = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const b = await fixture(t, { execute: async (_driver, _call, _display, _runId, context) => { await waiting; context.assertLive(); called++; } });
  const grant = b.spec("run", permission);
  const result = b.request(grant.token, { name: "get_desktop_state" });
  let decision;
  if (permission === "ask") {
    const row = b.list()[0];
    decision = b.decide(row.id, row.digest, true);
  }
  await Promise.resolve();
  b.suspend();
  release();
  await assert.rejects(result, /Not permitted/);
  if (decision) await decision;
  assert.equal(called, 0);
});
test("each broker action has its own trusted id and ask reuses the review id", async (t) => {
  const ids = [];
  const b = await fixture(t, { execute: async (_driver, _call, _display, _runId, context) => { ids.push(context.actionId); return 'ok'; } });
  const call = { name: 'click', arguments: { x: 1, y: 2 } };
  const allow = b.spec('allowed', 'allow');
  await b.request(allow.token, call);
  await b.request(allow.token, call);
  assert.notEqual(ids[0], ids[1]);
  const ask = b.spec('reviewed', 'ask');
  const pending = b.request(ask.token, call);
  const review = b.list()[0];
  await b.decide(review.id, review.digest, true);
  await pending;
  assert.equal(ids[2], review.id);
  assert.equal(new Set(ids).size, 3);
  await assert.rejects(() => b.decide(review.id, review.digest, true));
});
test("only pinned driver detected; missing/unexpected version absent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "driver-detect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "driver");
  await writeFile(file, "#!/bin/sh\necho cua-driver 0.38.0\n");
  await chmod(file, 0o700);
  assert.ok(await detectComputerDriver(file));
  await writeFile(file, "#!/bin/sh\necho cua-driver 9.0.0\n");
  assert.equal(await detectComputerDriver(file), null);
  assert.equal(await detectComputerDriver(join(dir, "missing")), null);
});
test("missing/deny/unknown permissions do not produce an MCP grant", async (t) => {
  const b = await fixture(t);
  for (const p of [undefined, "deny", "garbage"])
    assert.equal(b.spec("r", p), undefined);
  assert.ok(b.spec("r", "ask"));
  assert.ok(b.spec("r", "allow"));
  const absent = await fixture(t, { driver: null });
  assert.equal(absent.spec("r", "allow"), undefined);
});
test("strict allowlist rejects arbitrary tools, output paths and argument smuggling", () => {
  for (const value of [
    { name: "shell", arguments: {} },
    {
      name: "get_desktop_state",
      arguments: { screenshot_out_file: "/secret" },
    },
    { name: "click", arguments: { x: 1, y: 2, scope: "browser" } },
    { name: "click", arguments: { x: NaN, y: 2 } },
    { name: "type_text", arguments: { text: "" } },
    { name: "press_key", arguments: { key: "enter", modifiers: ["ctrl", "ctrl"] } },
    { name: "press_key", arguments: { key: "enter", modifiers: ["other"] } },
    { name: "scroll", arguments: { direction: "down", amount: 51, x: 1, y: 2 } },
    { name: "scroll", arguments: { direction: "down", amount: 1, x: 1, y: 2, scope: "window" } },
  ])
    assert.throws(() => normalizeCall(value));
});
test("keys and scrolling require the exact approval and use the selected desktop", async (t) => {
  const b = await fixture(t);
  const grant = b.spec("r", "ask", { display: ":1" });
  for (const call of [
    { name: "press_key", arguments: { key: "tab", modifiers: ["shift"] } },
    { name: "scroll", arguments: { direction: "down", amount: 2, x: 10, y: 20 } },
  ]) {
    const pending = b.request(grant.token, call);
    const row = b.list()[0];
    assert.deepEqual(row.call, call);
    assert.equal(row.display, ":1");
    await b.decide(row.id, row.digest, true);
    await pending;
  }
  for (const platform of ['linux', 'darwin']) assert.deepEqual(driverArguments({ name: 'type_text', arguments: { text: 'isolated marker' } }, platform),
    { text: 'isolated marker', scope: 'desktop', delivery_mode: 'foreground' });
  assert.deepEqual(driverArguments({ name: "press_key", arguments: { key: "tab" } }, "linux"), { key: "tab", scope: "desktop", delivery_mode: "foreground" });
  assert.deepEqual(driverArguments({ name: "scroll", arguments: { direction: "down", amount: 2, x: 10, y: 20 } }, "linux"), { direction: "down", amount: 2, x: 10, y: 20, scope: "desktop", coordinate_frame: "desktop", delivery_mode: "foreground" });
});
test("ask suspends; one exact review delivers result, replay denied", async (t) => {
  let calls = 0;
  const b = await fixture(t, {
    execute: async () => {
      calls++;
      return { ok: true };
    },
  });
  const grant = b.spec("r", "ask");
  const pending = b.request(grant.token, {
    name: "click",
    arguments: { y: 2, x: 1 },
  });
  assert.equal(calls, 0);
  const row = b.list()[0];
  assert.deepEqual(row.call.arguments, { x: 1, y: 2 });
  await assert.rejects(() => b.decide(row.id, "bad", true));
  assert.equal(calls, 0);
  await b.decide(row.id, row.digest, true);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(calls, 1);
  await assert.rejects(() => b.decide(row.id, row.digest, true));
});
test("allow executes once without an approval; deny and missing policy revoke earlier grants", async (t) => {
  let calls = 0;
  const b = await fixture(t, { execute: async (_, call, display, runId) => {
    calls++;
    return { call, display, runId };
  } });
  const grant = b.spec("run", "allow", { display: ":1" });
  const result = await b.request(grant.token, { name: "click", arguments: { x: 3, y: 4 } });
  assert.deepEqual(result, { call: { name: "click", arguments: { x: 3, y: 4 } }, display: ":1", runId: "run" });
  assert.equal(calls, 1);
  assert.deepEqual(b.list(), []);
  assert.equal(b.spec("run", "deny"), undefined);
  await assert.rejects(b.request(grant.token, { name: "get_desktop_state" }));
  const next = b.spec("run", "allow");
  assert.equal(b.spec("run", undefined), undefined);
  await assert.rejects(b.request(next.token, { name: "get_desktop_state" }));
  const malformed = b.spec("run", "allow");
  assert.throws(() => b.spec("run", "deny", { display: ":1;bad" }));
  await assert.rejects(b.request(malformed.token, { name: "get_desktop_state" }));
  assert.equal(calls, 1);
});
test("allow rechecks live authority, cancellation, grant replacement and driver identity before executing", async (t) => {
  let allowed = true, calls = 0;
  const b = await fixture(t, { permitted: () => allowed, execute: async () => { calls++; } });
  for (const mode of ["stop", "abort", "replace", "fingerprint"]) {
    allowed = true;
    b.driver = { ...driver };
    const grant = b.spec("run", "allow");
    const abort = new AbortController();
    const result = b.request(grant.token, { name: "get_desktop_state" }, abort.signal);
    if (mode === "stop") allowed = false;
    if (mode === "abort") abort.abort();
    if (mode === "replace") b.spec("run", "deny");
    if (mode === "fingerprint") b.driver.fingerprint = "changed";
    await assert.rejects(result);
  }
  assert.equal(calls, 0);
});
test("allow returns an uncertain driver error without retrying the operation", async (t) => {
  let calls = 0;
  const b = await fixture(t, { execute: async () => { calls++; throw new Error("outcome unknown"); } });
  const grant = b.spec("run", "allow");
  await assert.rejects(b.request(grant.token, { name: "click", arguments: { x: 1, y: 2 } }), /outcome unknown/);
  assert.equal(calls, 1);
  assert.deepEqual(b.list(), []);
});
test("denied, expired and newly forbidden requests never execute", async (t) => {
  for (const mode of ["deny", "expire", "policy"]) {
    let allowed = true,
      now = 100,
      calls = 0;
    const b = await fixture(t, {
      now: () => now,
      permitted: () => allowed,
      execute: async () => {
        calls++;
      },
    });
    const grant = b.spec("r", "ask");
    const promise = b.request(grant.token, { name: "get_desktop_state" });
    const rejected = assert.rejects(promise);
    const row = b.list()[0];
    if (mode === "expire") now += 300001;
    if (mode === "policy") allowed = false;
    await b.decide(row.id, row.digest, mode !== "deny");
    await rejected;
    assert.equal(calls, 0);
  }
});
test("failed/uncertain driver execution consumes approval permanently", async (t) => {
  const b = await fixture(t, {
    execute: async () => {
      throw new Error("outcome uncertain");
    },
  });
  const grant = b.spec("r", "ask");
  const rejected = assert.rejects(
    b.request(grant.token, { name: "get_desktop_state" }),
  );
  const row = b.list()[0];
  await b.decide(row.id, row.digest, true);
  await rejected;
  await assert.rejects(() => b.decide(row.id, row.digest, true));
  assert.deepEqual(b.list(), []);
});
test("closed broker discards pending approvals and old session grant is revoked", async (t) => {
  const b = await fixture(t);
  const old = b.spec("r", "ask");
  b.spec("r", "ask");
  await assert.rejects(() =>
    b.request(old.token, { name: "get_desktop_state" }),
  );
  const grant = b.spec("r", "ask");
  const rejected = assert.rejects(
    b.request(grant.token, { name: "get_desktop_state" }),
  );
  await b.close();
  await rejected;
  assert.deepEqual(b.list(), []);
});
test("real stdio MCP proxy holds call until trusted broker approval; cannot decide through request socket", async (t) => {
  const b = await fixture(t);
  await b.listen();
  const grant = b.spec("r", "ask");
  const child = spawn(process.execPath, [
    new URL("./proxy.mjs", import.meta.url).pathname,
    grant.socketPath,
    grant.token,
  ]);
  const replies = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (l) => replies.push(JSON.parse(l)));
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "click", arguments: { x: 3, y: 4 } },
    }) + "\n",
  );
  for (let i = 0; i < 100 && !b.list().length; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(replies.length, 0);
  const row = b.list()[0];
  assert.ok(row);
  await b.decide(row.id, row.digest, true);
  for (let i = 0; i < 100 && !replies.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(replies[0].id, 1);
  assert.match(replies[0].result.content[0].text, /'click'|"click"/);
  child.stdin.end();
  lines.close();
});

test("allow returns actual PNG bytes through the request-only MCP proxy to the scripted client", async (t) => {
  // A one-pixel PNG fixture; this validates image transport, not vision-model reasoning.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=";
  const b = await fixture(t, { execute: async () => ({ content: [{ type: "image", mimeType: "image/png", data: png }] }) });
  await b.listen();
  const grant = b.spec("run", "allow");
  const child = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname, grant.socketPath, grant.token]);
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const reply = new Promise(resolve => lines.once("line", line => resolve(JSON.parse(line))));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_desktop_state", arguments: {} } }) + "\n");
  const result = await reply;
  assert.equal(result.id, 1);
  const image = result.result.content.find(item => item.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.data, "base64"), Buffer.from(png, "base64"));
  assert.deepEqual(b.list(), []);
  child.stdin.end();
});

test("replaced run session and disconnected model discard pending execution", async (t) => {
  const b = await fixture(t);
  let grant = b.spec("r", "ask");
  const refused = assert.rejects(b.request(grant.token, { name: "get_desktop_state" }));
  const row = b.list()[0];
  b.spec("r", "ask");
  await assert.rejects(() => b.decide(row.id, row.digest, true));
  await refused;
  grant = b.spec("r", "ask");
  const abort = new AbortController();
  const cancelled = assert.rejects(b.request(grant.token, { name: "get_desktop_state" }, abort.signal));
  const next = b.list()[0];
  abort.abort();
  await cancelled;
  await assert.rejects(() => b.decide(next.id, next.digest, true));
});

test("pinned platform click schemas preserve desktop coordinates without unsupported macOS fields", () => {
  const call = { name: "click", arguments: { x: 216, y: 326 } };
  assert.deepEqual(driverArguments(call, "linux"), { x: 216, y: 326, scope: "desktop", coordinate_frame: "desktop", delivery_mode: "foreground" });
  assert.deepEqual(driverArguments(call, "darwin"), { x: 216, y: 326, scope: "desktop", delivery_mode: "foreground" });
  assert.throws(() => driverArguments({ name: "click", arguments: { x: 1, y: 2, scope: "window" } }, "darwin"));
});


test("concurrent approved runs execute on their own trusted display", async (t) => {
  const executions = [];
  const b = await fixture(t, { execute: async (_, call, display, runId) => {
    executions.push({ call, display, runId });
    return { ok: true };
  } });
  assert.throws(() => b.spec("bad", "ask", { display: ":0;touch /tmp/owned" }));
  const first = b.spec("run-a", "ask", { display: ":1" });
  const second = b.spec("run-b", "ask", { display: ":2" });
  const a = b.request(first.token, { name: "click", arguments: { x: 10, y: 20 } });
  const c = b.request(second.token, { name: "click", arguments: { x: 30, y: 40 } });
  const rows = b.list();
  assert.deepEqual(rows.map(row => row.display), [":1", ":2"]);
  await Promise.all(rows.map(row => b.decide(row.id, row.digest, true)));
  await Promise.all([a, c]);
  assert.deepEqual(executions.map(row => row.display), [":1", ":2"]);
  assert.deepEqual(executions.map(row => row.runId), ["run-a", "run-b"]);
  assert.throws(() => normalizeCall({ name: "click", arguments: { x: 1, y: 2, display: ":2" } }));
});
test("capture calls skip review but still need the run's grant", async (t) => {
  const calls = [];
  let allowed = true;
  const b = await fixture(t, {
    permitted: () => allowed,
    capture: async (runId, call) => { calls.push({ runId, call }); return { action: call.action, capture: { id: "c1" } }; },
  });
  const { token } = b.spec("run-1", "ask", { display: ":2" });
  assert.deepEqual(await b.captureRequest(token, { name: "capture_screenshot", arguments: { title: "  Login   page " } }), { result: { action: "screenshot", capture: { id: "c1" } } });
  assert.deepEqual(calls, [{ runId: "run-1", call: { action: "screenshot", title: "Login page" } }]);
  assert.equal(b.list().length, 0, "nothing waits for review");
  assert.deepEqual(await b.captureRequest("forged", { name: "capture_screenshot", arguments: { title: "x" } }), { error: "Not permitted" });
  allowed = false;
  assert.deepEqual(await b.captureRequest(token, { name: "stop_screen_recording", arguments: {} }), { error: "Not permitted" });
  assert.equal(calls.length, 1);
});
test("capture calls cannot choose the desktop, a path or a longer recording", async (t) => {
  const { normalizeCaptureCall, CAPTURE_TOOLS } = await import("./driver.mjs");
  assert.deepEqual(CAPTURE_TOOLS.map(tool => tool.name), ["capture_screenshot", "start_screen_recording", "stop_screen_recording", "mark_recording_step"]);
  for (const value of [
    { name: "capture_screenshot", arguments: { title: "x", display: ":3" } },
    { name: "capture_screenshot", arguments: { title: "x", path: "/etc/passwd" } },
    { name: "capture_screenshot", arguments: {} },
    { name: "start_screen_recording", arguments: { title: "x", maxSeconds: 3600 } },
    { name: "start_screen_recording", arguments: { title: "x", maxSeconds: 2.5 } },
    { name: "stop_screen_recording", arguments: { id: "other" } },
    { name: "get_desktop_state", arguments: {} },
    { name: "constructor", arguments: {} },
  ]) assert.throws(() => normalizeCaptureCall(value));
  assert.deepEqual(normalizeCaptureCall({ name: "start_screen_recording", arguments: { title: "Flow", maxSeconds: 60 } }), { action: "start_recording", title: "Flow", maxSeconds: 60 });
  const b = await fixture(t);
  const { token } = b.spec("run-1", "ask");
  assert.deepEqual(await b.captureRequest(token, { name: "capture_screenshot", arguments: { title: "x" } }), { error: "Not permitted" }, "no capture relay, no capture");
});
test("a refused capture tells the model only the server's own reason", async (t) => {
  const b = await fixture(t, { capture: async () => { throw Object.assign(new Error("https://e2b.internal/secret?key=1"), { safeMessage: "A recording is already going; stop it first." }); } });
  const { token } = b.spec("run-1", "ask");
  assert.deepEqual(await b.captureRequest(token, { name: "start_screen_recording", arguments: { title: "x" } }), { error: "Capture failed", detail: "A recording is already going; stop it first." });
  const quiet = await fixture(t, { capture: async () => { throw new Error("https://e2b.internal/secret?key=1"); } });
  const grant = quiet.spec("run-1", "ask");
  assert.deepEqual(await quiet.captureRequest(grant.token, { name: "capture_screenshot", arguments: { title: "x" } }), { error: "Capture failed" });
});
test("the proxy lists capture tools only with --captures and relays them over the socket", async (t) => {
  const b = await fixture(t, { capture: async (_runId, call) => ({ action: call.action, capture: { id: "c1", title: call.title } }) });
  await b.listen();
  const { token, socketPath } = b.spec("run-1", "ask");
  const ask = async (flags, messages) => {
    const child = spawn(process.execPath, [new URL("./proxy.mjs", import.meta.url).pathname, socketPath, token, ...flags]);
    const lines = createInterface({ input: child.stdout });
    const replies = new Map();
    lines.on("line", line => { const msg = JSON.parse(line); replies.set(msg.id, msg.result); });
    for (const message of messages) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    for (let i = 0; i < 100 && replies.size < messages.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    child.kill();
    return replies;
  };
  const plain = await ask([], [{ id: 1, method: "tools/list" }]);
  assert.ok(!plain.get(1).tools.some(tool => tool.name === "capture_screenshot"));
  const cloud = await ask(["--captures"], [{ id: 1, method: "tools/list" }, { id: 2, method: "tools/call", params: { name: "capture_screenshot", arguments: { title: "Home" } } }]);
  assert.ok(cloud.get(1).tools.some(tool => tool.name === "capture_screenshot"));
  assert.deepEqual(JSON.parse(cloud.get(2).content[0].text), { action: "screenshot", capture: { id: "c1", title: "Home" } });
  assert.equal(b.list().length, 0);
});

test("a done action's step goes on the recording timeline only while recording; the driver never sees it", async (t) => {
  const { normalizeCall, normalizeCaptureCall, TOOLS } = await import("./driver.mjs");
  for (const name of ["click", "type_text", "press_key", "scroll"]) assert.ok(TOOLS.find(tool => tool.name === name).inputSchema.required.includes("step"), `${name} asks for its step`);
  assert.deepEqual(normalizeCall({ name: "click", arguments: { x: 1, y: 2, step: "  Click  Sign in " } }), { name: "click", arguments: { x: 1, y: 2 } });
  assert.throws(() => normalizeCall({ name: "get_desktop_state", arguments: { step: "look" } }));
  assert.throws(() => normalizeCall({ name: "click", arguments: { x: 1, y: 2, step: " " } }));
  assert.deepEqual(normalizeCaptureCall({ name: "mark_recording_step", arguments: { label: "首屏出现" } }), { action: "step", label: "首屏出现", source: "mark" });
  assert.throws(() => normalizeCaptureCall({ name: "mark_recording_step", arguments: { label: "x", atMs: 5 } }));
  const relayed = [];
  const executed = [];
  let clock = 1_000;
  const b = await fixture(t, {
    now: () => clock,
    execute: async (_, call) => { executed.push(call); return { content: [] }; },
    capture: async (_runId, call) => {
      relayed.push(call);
      if (call.action === "start_recording") return { action: call.action, recordingId: "r1", stopsAt: new Date(clock + 60_000).toISOString() };
      return { action: call.action };
    },
  });
  const { token } = b.spec("run-1", "allow");
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await b.request(token, { name: "click", arguments: { x: 1, y: 2, step: "Before recording" } });
  await tick();
  assert.deepEqual(relayed, [], "no recording, no step");
  // Fake clock: Date.parse(stopsAt) is relative to the broker's own now().
  clock = Date.now();
  await b.captureRequest(token, { name: "start_screen_recording", arguments: { title: "Flow" } });
  await b.request(token, { name: "click", arguments: { x: 1, y: 2, step: "点击登录按钮" } });
  await tick();
  assert.deepEqual(relayed.at(-1), { action: "step", label: "点击登录按钮", source: "action" });
  assert.deepEqual(executed.at(-1), { name: "click", arguments: { x: 1, y: 2 } }, "the driver gets the action, never the description");
  await b.captureRequest(token, { name: "stop_screen_recording", arguments: {} });
  const count = relayed.length;
  await b.request(token, { name: "scroll", arguments: { direction: "down", amount: 3, x: 1, y: 2, step: "After" } });
  await tick();
  assert.equal(relayed.length, count, "a stopped recording takes no more steps");
});
