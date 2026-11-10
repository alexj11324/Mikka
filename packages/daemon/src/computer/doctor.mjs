// Fixed-shape health report for local computer use. It never carries screen
// content, window titles, driver stderr or free-form diagnostics: the person
// sees a stable status and a fixed remedy, and logs stay content-free.
import {
  grantComputerPermissions,
  inspectComputerDriver,
  probeComputerDriver,
  readComputerPermissions,
} from "./driver.mjs";

/**
 * The five failure classes, plus ok. A failed capture with unknown TCC
 * status is classified by the first grant it needs, never as a confirmed
 * denial: the permission states stay "unknown" in the report.
 */
export function computerDoctorStatus({ accessibility, screenRecording, captureConsent, probeOk }) {
  if (probeOk) return "ok";
  if (accessibility === "denied") return "accessibility_denied";
  if (screenRecording === "denied") return "screen_recording_denied";
  if (captureConsent === "denied") return "screen_recording_denied";
  if (accessibility === "unknown") return "accessibility_denied";
  if (screenRecording === "unknown") return "screen_recording_denied";
  return "capture_failed";
}

function report({ driver, version, binaryPath, permissions, probe }) {
  return {
    installed: Boolean(driver),
    version,
    binaryPath,
    accessibility: permissions.accessibility,
    screenRecording: permissions.screenRecording,
    captureConsent: permissions.captureConsent,
    probe: {
      status: probe.status ?? computerDoctorStatus({ ...permissions, probeOk: probe.ok }),
      ok: probe.ok,
      width: probe.width ?? null,
      height: probe.height ?? null,
    },
  };
}

/**
 * Looks, reads TCC and takes one real screenshot. `inspect`, `permissions`
 * and `probe` are seams for tests; production uses the driver functions.
 */
export async function doctorComputerDriver(options = {}) {
  const {
    binary,
    platform = process.platform,
    env = process.env,
    home,
    inspect = inspectComputerDriver,
    permissions = readComputerPermissions,
    probe = probeComputerDriver,
  } = options;
  const inspection = await inspect(binary, { platform, env, home });
  const driver = inspection.driver;
  const found = inspection.found?.[0] ?? null;
  if (!driver) {
    return report({
      driver: null,
      version: found?.version ?? null,
      binaryPath: found?.path ?? null,
      permissions: { accessibility: "unknown", screenRecording: "unknown", captureConsent: "unknown" },
      probe: { ok: false, status: found ? "binary_version" : "missing" },
    });
  }
  const states = await permissions(driver, { platform });
  const result = await probe(driver);
  return report({ driver, version: driver.version, binaryPath: driver.path, permissions: states, probe: result });
}

/**
 * The person's explicit "enable" action. The grant runs under CuaDriver's
 * app identity and waits for the macOS dialogs; only a GUI click may reach
 * this function, never a launch agent or a run. Whatever happens, the fresh
 * report says what is still missing without exposing driver output.
 */
export async function grantComputerAccess(options = {}) {
  const {
    binary,
    platform = process.platform,
    env = process.env,
    home,
    inspect = inspectComputerDriver,
    grant = grantComputerPermissions,
  } = options;
  const inspection = await inspect(binary, { platform, env, home });
  if (inspection.driver) {
    try {
      await grant(inspection.driver, { platform });
    } catch { /* The report below carries the outcome. */ }
  }
  return doctorComputerDriver(options);
}
