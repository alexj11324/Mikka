// Invokes the optional standalone cua-driver 0.38.0 (MIT), Copyright (c) 2025 Cua AI, Inc.
// See packages/daemon/THIRD_PARTY_NOTICES.md. No perception or Spaces extension is installed here.
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
const exec = promisify(execFile);
// The pinned release; a Mac may also have an older driver on PATH.
export const CUA_DRIVER_VERSION = "0.38.0";
const CUA_DRIVER_VERSION_PATTERN = /^cua-driver\s+0\.38\.0\b/;
const CUA_DRIVER_APP_PATH = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const PERMISSION_TIMEOUT_MS = 5000;
const GRANT_TIMEOUT_MS = 200000;
const PROBE_TIMEOUT_MS = 10000;
const DRIVER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];
// The only environment a driver child gets: no shell, credentials or agent env.
function driverEnvironment() {
  return Object.fromEntries(
    DRIVER_ENV_KEYS.flatMap((k) =>
      process.env[k] === undefined ? [] : [[k, process.env[k]]],
    ),
  );
}
/**
 * Stable places a local macOS install may put the driver, most specific
 * first. `MIKKA_CUA_DRIVER` pins one for acceptance and tests; other
 * platforms keep looking only at PATH.
 */
export function computerDriverCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const override = typeof env.MIKKA_CUA_DRIVER === "string" ? env.MIKKA_CUA_DRIVER.trim() : "";
  const candidates = override ? [override] : [];
  if (platform === "darwin") candidates.push(CUA_DRIVER_APP_PATH, join(home, ".local/bin/cua-driver"));
  candidates.push("cua-driver");
  return candidates;
}
async function resolveDriverCandidate(candidate) {
  const located = candidate.includes("/")
    ? candidate
    : (await exec("which", [candidate], { timeout: 5000 })).stdout.trim().split("\n")[0];
  if (!located) return null;
  return await realpath(located);
}
/**
 * Looks for the pinned driver without running an action. `found` lists every
 * executable that answered, so a caller can tell "not installed" from
 * "another version is installed". A cloud caller passing an explicit path
 * checks only that path.
 */
export async function inspectComputerDriver(binary, options = {}) {
  const candidates = binary === undefined ? computerDriverCandidates(options) : [binary];
  const found = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let path;
    try { path = await resolveDriverCandidate(candidate); } catch { continue; }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    let version = null;
    try {
      version = (await exec(path, ["--version"], { timeout: 5000 })).stdout.trim().split("\n")[0].trim() || null;
    } catch { /* Executable but not a usable driver. */ }
    found.push({ path, version });
    if (!version || !CUA_DRIVER_VERSION_PATTERN.test(version)) continue;
    try {
      return {
        driver: {
          installed: true,
          version,
          path,
          fingerprint: createHash("sha256").update(await readFile(path)).digest("hex"),
        },
        found,
      };
    } catch { /* Unreadable binary never becomes an approved driver. */ }
  }
  return { driver: null, found };
}
export async function detectComputerDriver(binary, options) {
  return (await inspectComputerDriver(binary, options)).driver;
}
const UNKNOWN_PERMISSIONS = Object.freeze({ accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown" });
const permissionState = (value) => value === true ? "granted" : value === false ? "denied" : "unknown";
/**
 * Normalizes `cua-driver permissions status --json` (0.38.0). The read-only
 * command answers through a running CuaDriver daemon; without one it reports
 * `status: "unknown"` and no booleans, which must never read as a denial.
 * `screen_recording_capturable` is null on read-only calls; a recorded direct
 * capture verification stands in for it.
 */
export function parseComputerPermissionStatus(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return { ...UNKNOWN_PERMISSIONS }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...UNKNOWN_PERMISSIONS };
  if (value.status === "unknown" || typeof value.accessibility !== "boolean" || typeof value.screen_recording !== "boolean")
    return { ...UNKNOWN_PERMISSIONS };
  const verified = value.direct_capture_verification;
  const captureConsent =
    typeof value.screen_recording_capturable === "boolean"
      ? permissionState(value.screen_recording_capturable)
      : value.direct_capture_status === "ready" || (verified && typeof verified === "object" && !Array.isArray(verified))
        ? "granted"
        : value.direct_capture_status === "unavailable" || value.direct_capture_status === "blocked_by_screen_recording"
          ? "denied"
          : "unknown";
  return {
    accessibility: permissionState(value.accessibility),
    screenRecording: permissionState(value.screen_recording),
    captureConsent,
  };
}
/** Read-only TCC status; never prompts and never runs the capture probe. */
export async function readComputerPermissions(driver, { platform = process.platform, run = exec } = {}) {
  if (platform !== "darwin") return { ...UNKNOWN_PERMISSIONS };
  try {
    const { stdout } = await run(driver.path, ["permissions", "status", "--json"], { timeout: PERMISSION_TIMEOUT_MS });
    return parseComputerPermissionStatus(stdout);
  } catch {
    return { ...UNKNOWN_PERMISSIONS };
  }
}
/**
 * Requests Accessibility, Screen Recording and direct-capture consent under
 * CuaDriver's own app identity. The person approves the macOS dialogs; the
 * command itself waits up to 180 seconds. Only a person's click may reach it.
 */
export async function grantComputerPermissions(driver, { platform = process.platform, run = exec } = {}) {
  if (platform !== "darwin") throw new Error("Computer permission grants require macOS");
  await run(driver.path, ["permissions", "grant"], { timeout: GRANT_TIMEOUT_MS });
}
function probeResult(result) {
  const failed = { ok: false, width: null, height: null };
  if (!result || typeof result !== "object" || result.isError === true) return failed;
  const structured = result.structuredContent;
  const width = Number.isInteger(structured?.screenshot_width) ? structured.screenshot_width : null;
  const height = Number.isInteger(structured?.screenshot_height) ? structured.screenshot_height : null;
  if (!width || !height || width <= 0 || height <= 0) return failed;
  const image = Array.isArray(result.content)
    ? result.content.find((part) => part?.type === "image" && typeof part.data === "string")
    : undefined;
  if (!image) return failed;
  const data = image.data.replace(/\s+/g, "");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) return failed;
  return { ok: true, width, height };
}
/**
 * Health check: one real screenshot through `mcp --direct`, bounded to ten
 * seconds. It returns only whether capture worked and its pixel size; the
 * image never leaves the child and driver stderr is never read.
 */
export function probeComputerDriver(driver, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const failed = { ok: false, width: null, height: null };
  return (async () => {
    let fingerprint;
    try {
      fingerprint = createHash("sha256").update(await readFile(driver.path)).digest("hex");
    } catch {
      return failed;
    }
    if (fingerprint !== driver.fingerprint) return failed;
    let child;
    try {
      child = spawn(driver.path, ["mcp", "--direct"], {
        env: driverEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return failed;
    }
    return await new Promise((resolve) => {
      let settled = false;
      let bytes = 0;
      let nextId = 0;
      let lines;
      const pending = new Map();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { lines?.close(); } catch { /* Already closed. */ }
        try { child.stdin.end(); } catch { /* Exited. */ }
        child.kill();
        resolve(result);
      };
      const send = (message) => {
        try { child.stdin.write(JSON.stringify(message) + "\n"); } catch { finish(failed); }
      };
      child.stderr.resume(); // Never forward driver or desktop output.
      child.on("error", () => finish(failed));
      child.stdin.on("error", () => finish(failed));
      child.on("exit", () => finish(failed));
      lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (settled) return;
        bytes += Buffer.byteLength(line);
        if (bytes > 24 * 1024 * 1024) return finish(failed);
        let message;
        try { message = JSON.parse(line); } catch { return finish(failed); }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) return finish(failed);
        if (waiter.kind === "initialize") {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          const id = ++nextId;
          pending.set(id, { kind: "capture" });
          send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_desktop_state", arguments: {} } });
          return;
        }
        finish(probeResult(message.result));
      });
      const timer = setTimeout(() => finish(failed), timeoutMs);
      const id = ++nextId;
      pending.set(id, { kind: "initialize" });
      send({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mikka-computer-doctor", version: "1" },
        },
      });
    });
  })();
}
// What an action does, in the person's words. While a screen recording runs it
// becomes a step on the recording's timeline (Figma 13), so it is never
// coordinates, keys or a tool name.
const step = {
  type: "string", minLength: 1, maxLength: 200,
  description: "What this action does, in plain words for the person watching (e.g. \"Click Sign in\", \"点击登录按钮\"). Shown on the screen recording's timeline; never coordinates or tool names.",
};
export const TOOLS = [
  {
    name: "get_desktop_state",
    description:
      "Screenshot this device desktop, subject to the computer permission policy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click this device desktop at the requested coordinates, subject to the computer permission policy.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, maximum: 100000 },
        y: { type: "integer", minimum: 0, maximum: 100000 },
        step,
      },
      required: ["x", "y", "step"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description:
      "Type exactly the requested text into the focused desktop control, subject to the computer permission policy.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 8000 }, step },
      required: ["text", "step"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: "Press the requested key and modifiers on the focused desktop, subject to the computer permission policy.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "shift", "alt", "super"] }, maxItems: 4, uniqueItems: true }, step },
      required: ["key", "step"], additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the requested amount at a desktop coordinate, subject to the computer permission policy.",
    inputSchema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 50 }, x: { type: "integer", minimum: 0, maximum: 100000 }, y: { type: "integer", minimum: 0, maximum: 100000 }, step },
      required: ["direction", "amount", "x", "y", "step"], additionalProperties: false,
    },
  },
];
// Cloud computer captures: evidence for the person, kept with the thread.
// They never return the image to the model, so they need no review; the
// server binds them to the run's own desktop (lib/captures/screen.ts).
const captureTitle = { type: "string", minLength: 1, maxLength: 200, description: "What it shows, for the person." };
export const CAPTURE_TOOLS = [
  {
    name: "capture_screenshot",
    description:
      "Save a screenshot of this thread's computer as evidence for the person. It is kept with the thread; you do not get the image back.",
    inputSchema: { type: "object", properties: { title: captureTitle }, required: ["title"], additionalProperties: false },
  },
  {
    name: "start_screen_recording",
    description:
      "Start recording this thread's computer screen as evidence for the person. One recording at a time; it stops by itself after maxSeconds (default 120, at most 300). Call stop_screen_recording when the flow you are showing is done.",
    inputSchema: {
      type: "object",
      properties: { title: captureTitle, maxSeconds: { type: "integer", minimum: 5, maximum: 300 } },
      required: ["title"], additionalProperties: false,
    },
  },
  {
    name: "stop_screen_recording",
    description: "Stop the screen recording and keep it with the thread.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mark_recording_step",
    description:
      "While recording, mark a moment that is not one of your actions (e.g. \"The first screen appears\", \"首屏出现\") on the recording's timeline. Each action's `step` is marked by itself.",
    inputSchema: { type: "object", properties: { label: step }, required: ["label"], additionalProperties: false },
  },
];
const CAPTURE_ACTIONS = { capture_screenshot: "screenshot", start_screen_recording: "start_recording", stop_screen_recording: "stop_recording", mark_recording_step: "step" };
const cleanStep = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
/** The action's own description for the recording timeline, or null. */
export function actionStep(value) {
  const label = cleanStep(value?.arguments?.step);
  return label && label.length <= 200 ? label : null;
}
export function normalizeCaptureCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool call");
  if (Object.keys(value).some((k) => !["name", "arguments"].includes(k))) throw new Error("Unknown call fields");
  const { name, arguments: args = {} } = value;
  const action = Object.hasOwn(CAPTURE_ACTIONS, name) ? CAPTURE_ACTIONS[name] : undefined;
  if (!action || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Unsupported tool or arguments");
  const keys = Object.keys(args).sort().join(",");
  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim() : "";
  if (action === "stop_recording" && !keys) return { action };
  if (action === "step" && keys === "label") {
    const label = cleanStep(args.label);
    if (label && label.length <= 200) return { action, label, source: "mark" };
  }
  if (action === "screenshot" && keys === "title" && title && title.length <= 200) return { action, title };
  if (action === "start_recording" && ["title", "maxSeconds,title"].includes(keys) && title && title.length <= 200 && (args.maxSeconds === undefined || (Number.isInteger(args.maxSeconds) && args.maxSeconds >= 5 && args.maxSeconds <= 300)))
    return { action, title, ...(args.maxSeconds === undefined ? {} : { maxSeconds: args.maxSeconds }) };
  throw new Error("Unsupported tool or arguments");
}
export const isCaptureTool = (name) => Object.hasOwn(CAPTURE_ACTIONS, name);
export function normalizeCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid tool call");
  if (Object.keys(value).some((k) => !["name", "arguments"].includes(k)))
    throw new Error("Unknown call fields");
  const { name, arguments: given = {} } = value;
  if (!given || typeof given !== "object" || Array.isArray(given))
    throw new Error("Invalid arguments");
  // `step` is the person's description, kept by the broker for the recording
  // timeline; it never reaches the driver or a review.
  const { step: described, ...args } = given;
  if (Object.hasOwn(given, "step") && (name === "get_desktop_state" || !cleanStep(described) || cleanStep(described).length > 200))
    throw new Error("Unsupported tool or arguments");
  const keys = Object.keys(args).sort().join(",");
  if (name === "get_desktop_state" && !keys) return { name, arguments: {} };
  if (
    name === "click" &&
    keys === "x,y" &&
    [args.x, args.y].every((v) => Number.isInteger(v) && v >= 0 && v <= 100000)
  )
    return { name, arguments: { x: args.x, y: args.y } };
  if (
    name === "type_text" &&
    keys === "text" &&
    typeof args.text === "string" &&
    args.text.length > 0 &&
    args.text.length <= 8000
  )
    return { name, arguments: { text: args.text } };
  if (name === "press_key" && ["key", "key,modifiers"].includes(keys) && typeof args.key === "string" && /^(?:[\x20-\x7e]|enter|return|tab|escape|space|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))$/.test(args.key) && (args.modifiers === undefined || (Array.isArray(args.modifiers) && args.modifiers.length <= 4 && new Set(args.modifiers).size === args.modifiers.length && args.modifiers.every(v => ["ctrl", "shift", "alt", "super"].includes(v)))))
    return { name, arguments: { key: args.key, ...(args.modifiers === undefined ? {} : { modifiers: args.modifiers }) } };
  if (name === "scroll" && keys === "amount,direction,x,y" && ["up", "down", "left", "right"].includes(args.direction) && Number.isInteger(args.amount) && args.amount >= 1 && args.amount <= 50 && [args.x, args.y].every(v => Number.isInteger(v) && v >= 0 && v <= 100000))
    return { name, arguments: { direction: args.direction, amount: args.amount, x: args.x, y: args.y } };
  throw new Error("Unsupported tool or arguments");
}
// The pinned release exposes different strict click schemas by platform.
// Both use top-left desktop coordinates; macOS rejects coordinate_frame.
export function driverArguments(input, platform = process.platform) {
  const call = normalizeCall(input);
  return call.name === "click"
    ? { ...call.arguments, scope: "desktop",
        ...(platform === "darwin" ? {} : { coordinate_frame: "desktop" }),
        delivery_mode: "foreground" }
    : ["type_text", "press_key"].includes(call.name) ? { ...call.arguments, scope: "desktop", delivery_mode: "foreground" }
      : call.name === "scroll" ? { ...call.arguments, scope: "desktop", ...(platform === "darwin" ? {} : { coordinate_frame: "desktop" }), delivery_mode: "foreground" }
        : call.arguments;
}
// Owned by the daemon, never by a harness. No shell, auto-update, host
// credentials, arbitrary tool names, output paths or browser attachment tools.
export async function executeDriver(driver, input, display, leaseGuard, assertLive = () => {}, beforeAction) {
  // Set the display per child, never process.env: concurrent bots must not race.
  if (display !== undefined && !/^:[1-9][0-9]{0,3}$/.test(display))
    throw new Error("Invalid desktop display");
  const call = normalizeCall(input);
  const fingerprint = createHash("sha256")
    .update(await readFile(driver.path))
    .digest("hex");
  if (fingerprint !== driver.fingerprint)
    throw new Error("Driver changed; restart and approve a new request");
  const args = driverArguments(call);
  const env = driverEnvironment();
  if (leaseGuard && (driver.path !== "/opt/mikka/computer/cua-driver" || display === undefined || typeof leaseGuard.botId !== "string" || typeof leaseGuard.ownerId !== "string" || !leaseGuard.botId || !leaseGuard.ownerId || !Number.isSafeInteger(leaseGuard.policyVersion) || leaseGuard.policyVersion < 0 || leaseGuard.policyVersion > 2147483647 || [leaseGuard.botId, leaseGuard.ownerId].some(value => value.length > 128 || value.includes("\0"))))
    throw new Error("Invalid desktop lease");
  const command = leaseGuard ? "flock" : driver.path;
  const argsForProcess = leaseGuard
    ? ["-F", "-s", `/run/mikka-viewer/${display.slice(1)}.lock`, "/usr/bin/python3", "/opt/mikka/computer/lease-driver.py", display, leaseGuard.botId, leaseGuard.ownerId, String(leaseGuard.policyVersion)]
    : ["mcp", "--direct"];
  assertLive();
  const child = spawn(command, argsForProcess, {
    env: { ...env, ...(display === undefined ? {} : { DISPLAY: display }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0,
    bytes = 0;
  const pending = new Map();
  const fail = (error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 24 * 1024 * 1024) {
      fail(new Error("Driver response too large"));
      child.kill();
      return;
    }
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error
          ? p.reject(new Error("Driver rejected operation"))
          : p.resolve(msg.result);
      }
    } catch {
      fail(new Error("Invalid driver response"));
    }
  });
  child.stderr.resume(); // Never forward desktop/process content to daemon logs.
  child.on("error", fail);
  // A driver that exits or closes its input mid-request: fail this action, never the worker.
  child.stdin.on("error", fail);
  child.on("exit", () =>
    fail(
      new Error(
        "Driver exited before confirming operation; no automatic retry",
      ),
    ),
  );
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n",
      );
    });
  const timer = setTimeout(() => {
    fail(
      new Error(
        "Driver timed out; outcome unknown, do not retry automatically",
      ),
    );
    child.kill();
  }, 30000);
  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mikka-approved-computer", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    if (beforeAction) await beforeAction();
    assertLive();
    return await request("tools/call", { name: call.name, arguments: args });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
