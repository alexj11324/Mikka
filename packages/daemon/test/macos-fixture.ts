// A native AppKit fixture for scripted computer-use acceptance. It never runs
// in production: a macOS test compiles it with swiftc and drives it through
// the real proxy/broker/driver. Coordinates are true screen pixels (points x
// backingScaleFactor), the same space get_desktop_state and click use.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const SWIFT_FIXTURE = String.raw`
import AppKit

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "click"
let output = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/tmp/mikka-acceptance-output"
let clickFile = output + ".click"
let typeFile = output + ".type"
let scrollFile = output + ".scroll"

class Target: NSObject {
  weak var window: NSWindow?
  var input: NSTextField?
  var scroll: NSScrollView?
  @objc func clicked(_ sender: Any?) {
    guard mode == "click" || mode == "all" else { return }
    try? "clicked".write(toFile: clickFile, atomically: true, encoding: .utf8)
    if mode == "click" { exit(0) }
    // The click moved focus to the button; typing must reach the field next.
    if let window = window, let input = input { window.makeFirstResponder(input) }
  }
  @objc func submitted(_ sender: Any?) {
    guard mode == "type" || mode == "all" else { return }
    try? (input?.stringValue ?? "").write(toFile: typeFile, atomically: true, encoding: .utf8)
    if mode == "type" { exit(0) }
  }
  @objc func scrolled(_ note: Notification) {
    guard mode == "scroll" || mode == "all" else { return }
    let y = scroll?.contentView.bounds.origin.y ?? 0
    // 0 is the initial layout notification, not a scroll.
    if y > 0 { try? String(y).write(toFile: scrollFile, atomically: true, encoding: .utf8) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.screens[0]
let scale = screen.backingScaleFactor
let desktopTop = screen.frame.maxY

let window = NSWindow(contentRect: NSRect(x: 240, y: 220, width: 520, height: 390), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Mikka computer-use acceptance"
window.level = .floating
let owner = Target()
owner.window = window

let scroll = NSScrollView(frame: NSRect(x: 14, y: 150, width: 492, height: 220))
scroll.hasVerticalScroller = true
scroll.contentView.postsBoundsChangedNotifications = true
let document = NSView(frame: NSRect(x: 0, y: 0, width: 492, height: 2200))
for i in 0..<44 {
  let label = NSTextField(labelWithString: "Row \(i) - Mikka scroll fixture")
  label.frame = NSRect(x: 8, y: CGFloat(i) * 48, width: 430, height: 20)
  document.addSubview(label)
}
scroll.documentView = document
window.contentView!.addSubview(scroll)
owner.scroll = scroll
NotificationCenter.default.addObserver(owner, selector: #selector(Target.scrolled(_:)), name: NSView.boundsDidChangeNotification, object: scroll.contentView)

let input = NSTextField(frame: NSRect(x: 14, y: 100, width: 492, height: 26))
input.target = owner
input.action = #selector(Target.submitted(_:))
window.contentView!.addSubview(input)
owner.input = input

let button = NSButton(title: "OK", target: owner, action: #selector(Target.clicked(_:)))
button.frame = NSRect(x: 14, y: 50, width: 90, height: 32)
window.contentView!.addSubview(button)

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
window.makeFirstResponder(input)

func pixel(_ point: NSPoint) -> (Int, Int) {
  return (Int((point.x * scale).rounded()), Int(((desktopTop - point.y) * scale).rounded()))
}
let buttonPoint = pixel(window.convertPoint(toScreen: NSPoint(x: button.frame.midX, y: button.frame.midY)))
let fieldPoint = pixel(window.convertPoint(toScreen: NSPoint(x: input.frame.midX, y: input.frame.midY)))
let scrollPoint = pixel(window.convertPoint(toScreen: NSPoint(x: scroll.frame.midX, y: scroll.frame.midY)))

DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
  window.makeFirstResponder(input)
  print("{\"button\":{\"x\":\(buttonPoint.0),\"y\":\(buttonPoint.1)},\"field\":{\"x\":\(fieldPoint.0),\"y\":\(fieldPoint.1)},\"scroll\":{\"x\":\(scrollPoint.0),\"y\":\(scrollPoint.1)}}")
  fflush(stdout)
}
app.run()
`;

export interface FixturePoints {
  button: { x: number; y: number };
  field: { x: number; y: number };
  scroll: { x: number; y: number };
}
export interface Fixture {
  child: ChildProcess;
  output: string;
  points: FixturePoints;
}
export type FixtureMode = "click" | "type" | "scroll" | "all";

/** Each observation has its own file, so one `all` fixture can serve four actions. */
export const fixtureFile = (fixture: Fixture, kind: "click" | "type" | "scroll"): string => `${fixture.output}.${kind}`;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function compileFixture(directory: string): Promise<string> {
  const source = join(directory, "fixture.swift");
  await writeFile(source, SWIFT_FIXTURE);
  const binary = join(directory, "fixture");
  execFileSync("swiftc", [source, "-o", binary], { stdio: "inherit" });
  return binary;
}

/** `all` stays alive and restores field focus after a click, so one app serves four actions. */
export async function startFixture(binary: string, mode: FixtureMode = "all"): Promise<Fixture> {
  const output = join(await mkdtemp(join(tmpdir(), `mikka-fixture-${mode}-`)), "output.txt");
  const child = spawn(binary, [mode, output], { stdio: ["ignore", "pipe", "inherit"] });
  const points = await new Promise<FixturePoints>((resolvePoints, reject) => {
    const ready = createInterface({ input: child.stdout! });
    ready.once("line", (line) => {
      ready.close();
      try { resolvePoints(JSON.parse(line) as FixturePoints); } catch { reject(new Error("invalid fixture coordinates")); }
    });
    child.once("error", () => reject(new Error("fixture did not start")));
    child.once("exit", () => reject(new Error("fixture exited before it was ready")));
  });
  await sleep(400);
  return { child, output, points };
}

export function waitExit(child: ChildProcess, timeoutMs = 10000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture did not exit after the action")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

export async function waitFile(file: string, timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await readFile(file, "utf8");
      if (value.length > 0) return value;
    } catch (error) {
      last = error;
    }
    await sleep(50);
  }
  throw new Error(`fixture did not write its observation: ${String(last)}`);
}
