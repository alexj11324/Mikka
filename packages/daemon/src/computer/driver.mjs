import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
const exec = promisify(execFile);
export async function detectComputerDriver(binary = "cua-driver") {
  try {
    const { stdout: located } = await exec("which", [binary], {
      timeout: 5000,
    });
    const path = await realpath(located.trim());
    const { stdout } = await exec(path, ["--version"], { timeout: 5000 });
    const version = stdout.trim().split("\n")[0];
    if (!/^cua-driver\s+0\.38\.0\b/.test(version)) return null;
    return {
      installed: true,
      version,
      path,
      fingerprint: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    };
  } catch {
    return null;
  }
}
export const TOOLS = [
  {
    name: "get_desktop_state",
    description:
      "Screenshot this device desktop. Requires exact human approval.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click this device desktop at the approved coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, maximum: 100000 },
        y: { type: "integer", minimum: 0, maximum: 100000 },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description:
      "Type exactly the approved text into the focused desktop control.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 8000 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];
export function normalizeCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid tool call");
  if (Object.keys(value).some((k) => !["name", "arguments"].includes(k)))
    throw new Error("Unknown call fields");
  const { name, arguments: args = {} } = value;
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Invalid arguments");
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
    : call.arguments;
}
// Owned by the daemon, never by a harness. No shell, auto-update, host
// credentials, arbitrary tool names, output paths or browser attachment tools.
export async function executeDriver(driver, input, display) {
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
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LANG",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
    ].flatMap((k) =>
      process.env[k] === undefined ? [] : [[k, process.env[k]]],
    ),
  );
  const child = spawn(driver.path, ["mcp", "--direct"], {
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
    return await request("tools/call", { name: call.name, arguments: args });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
