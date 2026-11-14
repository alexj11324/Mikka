// Local computer use: candidate paths, the pinned version gate, read-only TCC
// parsing, the real screenshot probe and the fixed five-class doctor. Pure
// macOS/Linux Node tests; no driver and no TCC needed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computerDriverCandidates,
  grantComputerPermissions,
  inspectComputerDriver,
  parseComputerPermissionStatus,
  probeComputerDriver,
  readComputerPermissions,
} from "./driver.mjs";
import { computerDoctorStatus, doctorComputerDriver, grantComputerAccess } from "./doctor.mjs";

const driverPath = (dir, body) => {
  const path = join(dir, "cua-driver");
  writeFileSync(path, body);
  chmodSync(path, 0o700);
  return path;
};
const driver = (path) => ({ installed: true, version: "cua-driver 0.38.0", path, fingerprint: createHash("sha256").update(readFileSync(path)).digest("hex") });
const json = (value) => JSON.stringify(value);

test("a local Mac looks at the app bundle and ~/.local/bin before PATH; other platforms keep PATH only", () => {
  const darwin = computerDriverCandidates({ platform: "darwin", env: {}, home: "/Users/person" });
  assert.deepEqual(darwin, [
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    "/Users/person/.local/bin/cua-driver",
    "cua-driver",
  ]);
  assert.deepEqual(computerDriverCandidates({ platform: "linux", env: {}, home: "/home/person" }), ["cua-driver"]);
  assert.deepEqual(
    computerDriverCandidates({ platform: "darwin", env: { MIKKA_CUA_DRIVER: " /custom/driver " }, home: "/Users/person" }),
    ["/custom/driver"],
  );
  assert.deepEqual(
    computerDriverCandidates({ platform: "linux", env: { MIKKA_CUA_DRIVER: "/custom/driver" }, home: "/home/person" }),
    ["/custom/driver"],
  );
});

test("the exact 0.38.0 release is accepted; another version is reported, not silently missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mikka-doctor-"));
  try {
    const pinned = driverPath(dir, "#!/bin/sh\nprintf 'cua-driver 0.38.0\\n'\n");
    const accepted = await inspectComputerDriver(pinned);
    assert.equal(accepted.driver?.version, "cua-driver 0.38.0");
    assert.equal(accepted.driver?.path, realpathSync(pinned));
    assert.match(accepted.driver?.fingerprint ?? "", /^[a-f0-9]{64}$/);

    const older = join(dir, "older");
    writeFileSync(older, "#!/bin/sh\nprintf 'cua-driver 0.23.2\\n'\n");
    chmodSync(older, 0o700);
    const rejected = await inspectComputerDriver(older);
    assert.equal(rejected.driver, null);
    assert.deepEqual(rejected.found, [{ path: realpathSync(older), version: "cua-driver 0.23.2" }]);

    const prefixed = join(dir, "prefixed");
    writeFileSync(prefixed, "#!/bin/sh\nprintf 'cua-driver 0.38.01\\n'\n");
    chmodSync(prefixed, 0o700);
    assert.equal((await inspectComputerDriver(prefixed)).driver, null);

    const missing = await inspectComputerDriver(join(dir, "nope"));
    assert.deepEqual(missing, { driver: null, found: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only TCC status: unknown is unknown, never a denial; direct-capture verification counts as consent", () => {
  assert.deepEqual(parseComputerPermissionStatus(json({ daemon_running: false, status: "unknown", reason: "no daemon" })), {
    accessibility: "unknown",
    screenRecording: "unknown",
    captureConsent: "unknown",
  });
  assert.deepEqual(parseComputerPermissionStatus("not json"), {
    accessibility: "unknown",
    screenRecording: "unknown",
    captureConsent: "unknown",
  });
  assert.deepEqual(
    parseComputerPermissionStatus(json({ accessibility: true, screen_recording: false, screen_recording_capturable: null, direct_capture_status: "not_checked" })),
    { accessibility: "granted", screenRecording: "denied", captureConsent: "unknown" },
  );
  assert.deepEqual(
    parseComputerPermissionStatus(json({
      accessibility: true, screen_recording: true, screen_recording_capturable: null, direct_capture_status: "not_checked",
      direct_capture_verification: { source: "grant", verified_at: "2026-11-01T00:00:00Z", bundle_id: "com.trycua.driver" },
    })),
    { accessibility: "granted", screenRecording: "granted", captureConsent: "granted" },
  );
  assert.deepEqual(
    parseComputerPermissionStatus(json({ accessibility: true, screen_recording: true, screen_recording_capturable: true })),
    { accessibility: "granted", screenRecording: "granted", captureConsent: "granted" },
  );
  assert.deepEqual(
    parseComputerPermissionStatus(json({ accessibility: true, screen_recording: true, screen_recording_capturable: false })),
    { accessibility: "granted", screenRecording: "granted", captureConsent: "denied" },
  );
  assert.deepEqual(
    parseComputerPermissionStatus(json({ accessibility: true, screen_recording: true, screen_recording_capturable: null, direct_capture_status: "unavailable" })),
    { accessibility: "granted", screenRecording: "granted", captureConsent: "denied" },
  );
});

test("TCC commands exist only on macOS: other platforms report unknown and refuse to grant", async () => {
  const fake = { path: "/driver", installed: true, version: "cua-driver 0.38.0", fingerprint: "f" };
  assert.deepEqual(await readComputerPermissions(fake, { platform: "linux" }), {
    accessibility: "unknown",
    screenRecording: "unknown",
    captureConsent: "unknown",
  });
  await assert.rejects(() => grantComputerPermissions(fake, { platform: "linux" }), /macOS/);
});

function probeDriver(dir, { data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", width = 1, height = 1, reply = true } = {}) {
  const path = join(dir, `probe-${Math.random().toString(16).slice(2)}`);
  writeFileSync(path, `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!${reply}) return;
  if (message.method === "initialize") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  if (message.method === "tools/call") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
    content: [{ type: "image", mimeType: "image/png", data: ${JSON.stringify(data)} }],
    structuredContent: { screenshot_width: ${width}, screenshot_height: ${height} },
  } }) + "\\n");
});
`);
  chmodSync(path, 0o700);
  return driver(path);
}

test("the health probe needs a decodable image with positive pixel dimensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mikka-probe-"));
  try {
    assert.deepEqual(await probeComputerDriver(probeDriver(dir, { width: 3840, height: 2160 })), { ok: true, width: 3840, height: 2160 });
    assert.deepEqual(await probeComputerDriver(probeDriver(dir, { width: 0, height: 0 })), { ok: false, width: null, height: null });
    assert.deepEqual(await probeComputerDriver(probeDriver(dir, { data: "not base64!!" })), { ok: false, width: null, height: null });
    assert.deepEqual(await probeComputerDriver(probeDriver(dir, { reply: false }), { timeoutMs: 150 }), { ok: false, width: null, height: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the doctor separates missing, wrong version, both denied grants and a failed capture", async () => {
  const pinned = { installed: true, version: "cua-driver 0.38.0", path: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver", fingerprint: "f" };
  const inspect = (result) => async () => result;
  const granted = { accessibility: "granted", screenRecording: "granted", captureConsent: "granted" };

  assert.deepEqual(
    await doctorComputerDriver({ inspect: inspect({ driver: null, found: [] }), platform: "darwin" }),
    {
      installed: false, version: null, binaryPath: null,
      accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown",
      probe: { status: "missing", ok: false, width: null, height: null },
    },
  );
  const wrong = await doctorComputerDriver({
    inspect: inspect({ driver: null, found: [{ path: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver", version: "cua-driver 0.23.2" }] }),
    platform: "darwin",
  });
  assert.equal(wrong.installed, false);
  assert.equal(wrong.version, "cua-driver 0.23.2");
  assert.equal(wrong.binaryPath, "/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
  assert.equal(wrong.probe.status, "binary_version");

  const ok = await doctorComputerDriver({
    inspect: inspect({ driver: pinned, found: [{ path: pinned.path, version: pinned.version }] }),
    permissions: async () => granted,
    probe: async () => ({ ok: true, width: 2560, height: 1600 }),
    platform: "darwin",
  });
  assert.equal(ok.probe.status, "ok");
  assert.equal(ok.probe.width, 2560);
  assert.equal(ok.installed, true);

  const accessibility = await doctorComputerDriver({
    inspect: inspect({ driver: pinned, found: [] }),
    permissions: async () => ({ ...granted, accessibility: "denied" }),
    probe: async () => { throw new Error("the probe must not run without Accessibility"); },
    platform: "darwin",
  });
  assert.equal(accessibility.probe.status, "accessibility_denied");
  assert.equal(accessibility.accessibility, "denied");

  const screen = await doctorComputerDriver({
    inspect: inspect({ driver: pinned, found: [] }),
    permissions: async () => ({ ...granted, screenRecording: "denied" }),
    probe: async () => { throw new Error("the probe must not run without Screen Recording"); },
    platform: "darwin",
  });
  assert.equal(screen.probe.status, "screen_recording_denied");

  const capture = await doctorComputerDriver({
    inspect: inspect({ driver: pinned, found: [] }),
    permissions: async () => granted,
    probe: async () => ({ ok: false }),
    platform: "darwin",
  });
  assert.equal(capture.probe.status, "capture_failed");

  // Unknown TCC plus a failed capture is not a confirmed denial; the probe
  // is skipped (it must never raise the consent dialog), so the report says
  // capture_failed while all three states stay unknown.
  let probed = false;
  const unknown = await doctorComputerDriver({
    inspect: inspect({ driver: pinned, found: [] }),
    permissions: async () => ({ accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown" }),
    probe: async () => { probed = true; return { ok: false }; },
    platform: "darwin",
  });
  assert.equal(unknown.probe.status, "capture_failed");
  assert.equal(unknown.accessibility, "unknown");
  assert.equal(probed, false, "the capture probe is gated on read-only grants");
});

test("a working capture is ok even when read-only status cannot see TCC", () => {
  assert.equal(computerDoctorStatus({ accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown", probeOk: true }), "ok");
  assert.equal(computerDoctorStatus({ accessibility: "granted", screenRecording: "granted", captureConsent: "unknown", probeOk: false }), "capture_failed");
  assert.equal(computerDoctorStatus({ accessibility: "granted", screenRecording: "unknown", captureConsent: "unknown", probeOk: false }), "capture_failed");
  assert.equal(computerDoctorStatus({ accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown", probeOk: false }), "capture_failed");
});

test("the person's grant runs once and the answer is the post-grant report", async () => {
  const pinned = { installed: true, version: "cua-driver 0.38.0", path: "/driver", fingerprint: "f" };
  let inspections = 0;
  let grants = 0;
  const result = await grantComputerAccess({
    platform: "darwin",
    inspect: async () => {
      inspections++;
      return { driver: pinned, found: [{ path: pinned.path, version: pinned.version }] };
    },
    grant: async () => { grants++; },
    permissions: async () => ({ accessibility: "granted", screenRecording: "granted", captureConsent: "unknown" }),
    probe: async () => ({ ok: true, width: 100, height: 50 }),
  });
  assert.equal(inspections, 2, "the report after the grant is a fresh look");
  assert.equal(grants, 1);
  assert.equal(result.probe.status, "ok");

  grants = 0;
  const missing = await grantComputerAccess({
    platform: "darwin",
    inspect: async () => ({ driver: null, found: [] }),
    grant: async () => { grants++; },
    permissions: async () => ({ accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown" }),
    probe: async () => ({ ok: false }),
  });
  assert.equal(grants, 0, "there is nothing to grant without a pinned driver");
  assert.equal(missing.probe.status, "missing");
});
