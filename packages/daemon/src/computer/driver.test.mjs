// A desktop driver that goes away mid-request fails that one action; it never
// takes the worker down (production, 2026-11-02: an unhandled EPIPE on the
// driver's stdin killed the cloud worker and every run on it was lost).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeDriver } from "./driver.mjs";

test("a driver that closes its input before answering rejects the action without an unhandled error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mikka-driver-"));
  try {
    const path = join(dir, "driver");
    // Closes stdin at once, then lives a moment longer, so the request is written to a closed pipe.
    writeFileSync(path, "#!/bin/sh\nexec 0<&-\nsleep 1\n");
    chmodSync(path, 0o700);
    const driver = { path, fingerprint: createHash("sha256").update(readFileSync(path)).digest("hex") };
    const unhandled = [];
    const record = (error) => unhandled.push(error);
    process.on("uncaughtException", record);
    try {
      await assert.rejects(executeDriver(driver, { name: "get_desktop_state", arguments: {} }), /EPIPE|Driver exited/);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      process.off("uncaughtException", record);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
