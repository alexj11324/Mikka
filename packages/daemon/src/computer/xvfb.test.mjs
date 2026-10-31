// Real pinned-driver test; launch only on an isolated Xvfb display. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { writeFile, readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectComputerDriver } from "./driver.mjs";
import { ComputerBroker } from "./broker.mjs";
import { createInterface } from "node:readline";
const binary = process.env.MIKKA_CUA_TEST_BINARY;
test(
  "pinned real driver: default allow -> screenshot -> input/click -> observed desktop change",
  { skip: !binary, timeout: 90000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "cua-real-"));
    const previousHome = process.env.HOME, previousDisplay = process.env.DISPLAY;
    process.env.HOME = join(dir, 'home');
    await mkdir(join(process.env.HOME, '.cua'), { recursive: true });
    await writeFile(join(process.env.HOME, '.cua', 'config.toml'), '[telemetry]\nenabled = false\n');
    t.after(() => {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
    });
    const driver = await detectComputerDriver(binary);
    assert.ok(driver, "pinned driver must exist");
    const typedFile = join(dir, 'typed.txt'), marker = 'Mikka isolated CUA input';
    let dialog, clickAt;
    if (process.platform === "darwin") {
      const source = join(dir, "dialog.swift");
      await writeFile(source, `import AppKit
class ReviewTarget: NSObject {
  var input: NSTextField?
  @objc func clicked(_ sender: Any?) {
    try? input?.stringValue.write(toFile: ${JSON.stringify(typedFile)}, atomically: true, encoding: .utf8)
    exit(0)
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 400, height: 140), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Mikka isolated approved click"
let label = NSTextField(labelWithString: "Mikka isolated computer-use test")
label.frame = NSRect(x: 10, y: 80, width: 370, height: 30)
window.contentView!.addSubview(label)
let input = NSTextField(frame: NSRect(x: 10, y: 45, width: 370, height: 24))
window.contentView!.addSubview(input)
let owner = ReviewTarget()
owner.input = input
let button = NSButton(title: "OK", target: owner, action: #selector(ReviewTarget.clicked(_:)))
button.frame = NSRect(x: 10, y: 10, width: 80, height: 30)
window.contentView!.addSubview(button)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
window.makeFirstResponder(input)
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
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        if (xvfb.exitCode !== null) throw new Error(`Xvfb exited: ${xvfb.exitCode}`);
        try { execFileSync("xdpyinfo", [], { stdio: "ignore" }); ready = true; }
        catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      assert.ok(ready, "isolated X display did not become ready");
      dialog = spawn("xmessage", ["-title", "Mikka approved click", "-geometry", "400x140+200+200", "-buttons", "OK:0", "Mikka isolated computer-use test"]);
      let diagnostic = "", window = "";
      dialog.stderr.on("data", chunk => { diagnostic += chunk.toString(); });
      for (let i = 0; i < 100 && !window; i++) {
        if (dialog.exitCode !== null) throw new Error(`xmessage exited: ${dialog.exitCode}: ${diagnostic}`);
        try { window = execFileSync("xdotool", ["search", "--name", "Mikka approved click"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]; }
        catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      assert.ok(window);
      clickAt = { x: 216, y: 326 };
    }
    t.after(async () => {
      dialog.kill();
      await rm(dir, { recursive: true, force: true });
    });
    const broker = new ComputerBroker({
      transport: "tcp",
      driver,
      socketPath: join(dir, "socket"),
      permitted: () => true,
    });
    t.after(() => broker.close());
    await broker.listen();
    assert.equal(broker.spec('denied-test', 'deny'), undefined);
    const grant = broker.spec("isolated-test", "allow");
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
    async function allowed(call) {
      const id = ++next;
      proxy.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: call,
        }) + "\n",
      );
      assert.equal(broker.list().length, 0, 'default allow must not create a human approval');
      for (let i = 0; i < 1600 && !replies.has(id); i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        replies.has(id),
        "actual result must return to the same model tool call",
      );
      return replies.get(id);
    }
    const before = await allowed({ name: "get_desktop_state" });
    assert.notEqual(before.isError, true, JSON.stringify(before));
    const image = before.content.find((c) => c.type === "image");
    assert.ok(image, "real desktop screenshot returned");
    if (process.env.MIKKA_CUA_TEST_SCREENSHOT)
      await writeFile(
        process.env.MIKKA_CUA_TEST_SCREENSHOT,
        Buffer.from(image.data, "base64"),
      );
    if (process.platform === 'darwin') {
      const typed = await allowed({ name: 'type_text', arguments: { text: marker } });
      assert.notEqual(typed.isError, true, JSON.stringify(typed));
    }
    // Require an actual desktop state transition, not just a command receipt.
    const click = await allowed({ name: "click", arguments: clickAt });
    assert.notEqual(click.isError, true, JSON.stringify(click));
    for (let i = 0; i < 30 && dialog.exitCode === null; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      dialog.exitCode,
      0,
      "real allowed click dismissed the dialog",
    );
    if (process.platform !== 'darwin') {
      const terminal = spawn('xterm', ['-title', 'Mikka isolated input', '-geometry', '60x5+200+200', '-e', process.execPath, '-e',
        "process.stdin.setEncoding('utf8');let value='';process.stdin.on('data',chunk=>{value+=chunk;if(value.includes('\\n')){require('node:fs').writeFileSync(process.argv[1],value.trim());process.exit(0)}})", typedFile]);
      t.after(() => terminal.kill());
      let window = '';
      for (let i = 0; i < 100 && !window; i++) {
        try { window = execFileSync('xdotool', ['search', '--name', '^Mikka isolated input$'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      assert.ok(window, 'isolated terminal input did not become ready');
      execFileSync('xdotool', ['windowfocus', '--sync', window]);
      const typed = await allowed({ name: 'type_text', arguments: { text: marker } });
      assert.notEqual(typed.isError, true, JSON.stringify(typed));
      const enter = await allowed({ name: 'press_key', arguments: { key: 'enter' } });
      assert.notEqual(enter.isError, true, JSON.stringify(enter));
      for (let i = 0; i < 50 && terminal.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(terminal.exitCode, 0, 'real driver input did not reach the isolated application');
    }
    assert.equal(await readFile(typedFile, 'utf8'), marker, 'observed application text must match the typed marker');
    const after = await allowed({ name: "get_desktop_state" });
    assert.notEqual(after.isError, true);
    assert.ok(after.content.some((c) => c.type === "image"));
    const afterImage = after.content.find((c) => c.type === "image");
    if (process.env.MIKKA_CUA_TEST_SCREENSHOT)
      await writeFile(
        process.env.MIKKA_CUA_TEST_SCREENSHOT.replace(/\.png$/, "-after.png"),
        Buffer.from(afterImage.data, "base64"),
      );
    console.log(
      "real screenshot, typed application text and click successful through default-allow MCP broker; no human review",
    );
  },
);
