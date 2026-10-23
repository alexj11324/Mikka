import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ComputerBroker } from "./broker.mjs";
import { normalizeCall, detectComputerDriver } from "./driver.mjs";
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
  t.after(async () => {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  });
  return broker;
}
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
  ])
    assert.throws(() => normalizeCall(value));
});
test("ask and allow both suspend; one exact review delivers result, replay denied", async (t) => {
  for (const permission of ["ask", "allow"]) {
    let calls = 0;
    const b = await fixture(t, {
      execute: async () => {
        calls++;
        return { ok: true };
      },
    });
    const grant = b.spec("r", permission);
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
  }
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
  t.after(() => child.kill());
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

test("replaced run session and disconnected model discard pending execution", async (t) => {
  const b = await fixture(t);
  let grant = b.spec("r", "ask");
  const refused = assert.rejects(b.request(grant.token, { name: "get_desktop_state" }));
  const row = b.list()[0];
  b.spec("r", "ask");
  await b.decide(row.id, row.digest, true);
  await refused;
  grant = b.spec("r", "ask");
  const abort = new AbortController();
  const cancelled = assert.rejects(b.request(grant.token, { name: "get_desktop_state" }, abort.signal));
  const next = b.list()[0];
  abort.abort();
  await cancelled;
  await assert.rejects(() => b.decide(next.id, next.digest, true));
});
