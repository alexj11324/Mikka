// Real pinned-driver test; launch only on an isolated Xvfb display. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectComputerDriver } from "./driver.mjs";
import { ComputerBroker } from "./broker.mjs";
import { createInterface } from "node:readline";
import { RpcServer } from "../rpc/server.ts";
import { connectDaemon } from "../rpc/client.ts";
import { DAEMON_PROTOCOL_VERSION } from "@mikka/protocol";
const binary = process.env.MIKKA_CUA_TEST_BINARY;
test(
  "pinned real driver: approval -> screenshot -> click -> observed desktop change",
  { skip: !binary, timeout: 90000 },
  async (t) => {
    const driver = await detectComputerDriver(binary);
    assert.ok(driver, "pinned driver must exist");
    const dir = await mkdtemp(join(tmpdir(), "cua-real-"));
    let dialog, clickAt;
    if (process.platform === "darwin") {
      const source = join(dir, "dialog.swift");
      await writeFile(source, `import AppKit
class ReviewTarget: NSObject {
  @objc func clicked(_ sender: Any?) { exit(0) }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 400, height: 140), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Mikka isolated approved click"
let label = NSTextField(labelWithString: "Mikka isolated computer-use test")
label.frame = NSRect(x: 10, y: 80, width: 370, height: 30)
window.contentView!.addSubview(label)
let owner = ReviewTarget()
let button = NSButton(title: "OK", target: owner, action: #selector(ReviewTarget.clicked(_:)))
button.frame = NSRect(x: 10, y: 10, width: 80, height: 30)
window.contentView!.addSubview(button)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
let point = window.convertPoint(toScreen: NSPoint(x: 50, y: 25))
let desktopTop = NSScreen.screens[0].frame.maxY
print("\\(Int(point.x)) \\(Int(desktopTop - point.y))")
fflush(stdout)
app.run()
`);
      execFileSync("swiftc", [source, "-o", join(dir, "dialog")]);
      dialog = spawn(join(dir, "dialog"));
      clickAt = await new Promise((resolve, reject) => {
        // Read a complete line: stdout chunks need not end on a coordinate.
        const ready = createInterface({ input: dialog.stdout });
        ready.once("line", (line) => {
          ready.close();
          const values = line.trim().split(/\s+/).map(Number);
          if (values.length !== 2 || !values.every((v) => Number.isInteger(v) && v >= 0 && v <= 100000))
            return reject(new Error("Invalid native desktop coordinates"));
          resolve({ x: values[0], y: values[1] });
        });
        dialog.once("error", reject);
        dialog.once("exit", () => reject(new Error("Desktop fixture exited before ready")));
      });
    } else {
      const display = ":143";
      process.env.DISPLAY = display;
      const xvfb = spawn("Xvfb", [display, "-screen", "0", "1024x768x24", "-nolisten", "tcp"]);
      t.after(() => xvfb.kill());
      await new Promise((r) => setTimeout(r, 700));
      dialog = spawn("xmessage", ["-title", "Mikka approved click", "-geometry", "400x140+200+200", "-buttons", "OK:0", "Mikka isolated computer-use test"]);
      await new Promise((r) => setTimeout(r, 500));
      const window = execFileSync("xdotool", ["search", "--name", "Mikka approved click"], { encoding: "utf8" }).trim().split("\n")[0];
      assert.ok(window);
      clickAt = { x: 216, y: 326 };
    }
    t.after(async () => {
      dialog.kill();
      await rm(dir, { recursive: true, force: true });
    });
    const broker = new ComputerBroker({
      driver,
      socketPath: join(dir, "socket"),
      permitted: () => true,
    });
    t.after(() => broker.close());
    const grant = broker.spec("isolated-test", "ask");
    await broker.listen();
    const server = new RpcServer({
      socketPath: join(dir, "rpc"),
      secret: "isolated-owner",
      hello: () => ({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        daemonVersion: "test",
        pid: process.pid,
        startedAt: new Date().toISOString(),
        flavor: "dev",
        dataDir: dir,
      }),
      handlers: {
        "computer.pending": () => broker.list(),
        "computer.decide": ({ id, digest, approve }) =>
          broker.decide(id, digest, approve),
      },
      log: { error() {}, warn() {}, info() {}, debug() {} },
    });
    await server.listen();
    t.after(() => server.close());
    const owner = await connectDaemon({
      socketPath: join(dir, "rpc"),
      secret: "isolated-owner",
      client: { name: "isolated-owner", version: "1" },
    });
    t.after(() => owner.close());
    const proxy = spawn(process.execPath, [
      new URL("./proxy.mjs", import.meta.url).pathname,
      grant.socketPath,
      grant.token,
    ]);
    t.after(() => proxy.kill());
    const replies = new Map();
    const lines = createInterface({ input: proxy.stdout });
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      replies.set(msg.id, msg.result);
    });
    t.after(() => lines.close());
    let next = 0;
    async function approved(call) {
      const id = ++next;
      proxy.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: call,
        }) + "\n",
      );
      let row;
      for (let i = 0; i < 100 && !row; i++) {
        [row] = await owner.request("computer.pending");
        if (!row) await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(row, "exact call must reach authenticated review");
      assert.equal(replies.has(id), false, "model call must still be blocked");
      await owner.request("computer.decide", {
        id: row.id,
        digest: row.digest,
        approve: true,
      });
      for (let i = 0; i < 1600 && !replies.has(id); i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        replies.has(id),
        "actual result must return to the same model tool call",
      );
      return replies.get(id);
    }
    const before = await approved({ name: "get_desktop_state" });
    assert.notEqual(before.isError, true, JSON.stringify(before));
    const image = before.content.find((c) => c.type === "image");
    assert.ok(image, "real desktop screenshot returned");
    if (process.env.MIKKA_CUA_TEST_SCREENSHOT)
      await writeFile(
        process.env.MIKKA_CUA_TEST_SCREENSHOT,
        Buffer.from(image.data, "base64"),
      );
    // Require an actual desktop state transition, not just a command receipt.
    const click = await approved({ name: "click", arguments: clickAt });
    assert.notEqual(click.isError, true, JSON.stringify(click));
    for (let i = 0; i < 30 && dialog.exitCode === null; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      dialog.exitCode,
      0,
      "real approved click dismissed the dialog",
    );
    const after = await approved({ name: "get_desktop_state" });
    assert.notEqual(after.isError, true);
    assert.ok(after.content.some((c) => c.type === "image"));
    const afterImage = after.content.find((c) => c.type === "image");
    if (process.env.MIKKA_CUA_TEST_SCREENSHOT)
      await writeFile(
        process.env.MIKKA_CUA_TEST_SCREENSHOT.replace(/\.png$/, "-after.png"),
        Buffer.from(afterImage.data, "base64"),
      );
    console.log(
      "real screenshot and click successful through MCP and authenticated RPC",
    );
  },
);
