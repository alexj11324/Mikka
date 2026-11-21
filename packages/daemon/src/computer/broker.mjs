import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { actionStep, normalizeCall, normalizeCaptureCall, executeDriver } from "./driver.mjs";
export class ComputerBroker {
  grants = new Map();
  // runId → when its screen recording stops by itself; only set while one runs.
  recordingUntil = new Map();
  recordingSteps = new Map();
  recordingTimingFailed = new Set();
  sockets = new Set();
  suspended = false;
  constructor({
    driver,
    socketPath,
    transport = "unix",
    permitted,
    execute = (driver, call, display, _runId, context) => executeDriver(driver, call, display, undefined, context.assertLive),
    capture,
    now = Date.now,
    ttl = 300000,
  }) {
    Object.assign(this, { driver, socketPath, permitted, execute, capture, now, ttl, transport });
  }
  spec(runId, permission, { display } = {}) {
    // A new policy or session invalidates every previous grant for this run,
    // including when the new choice is deny or absent.
    for (const [old, grant] of this.grants)
      if (grant.runId === runId) this.revoke(old);
    // Cloud desktops must be bound by the trusted caller, never the model.
    if (display !== undefined && !/^:[1-9][0-9]{0,2}$/.test(display))
      throw new Error("Invalid desktop display");
    // Missing or unknown policy never grants access.
    if (this.suspended || (this.transport === "tcp" && !this.server?.listening) || !this.driver || !permission || !["ask", "allow"].includes(permission))
      return undefined;
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, { runId, fingerprint: this.driver.fingerprint, display, permission });
    return { socketPath: this.socketPath, token };
  }
  async listen() {
    if (this.suspended) throw new Error("Broker suspended");
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let text = "",
        submitted = false;
      socket.setTimeout(this.ttl + 31000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", (data) => {
        if (submitted) return;
        text += data.toString();
        if (text.length > 20000) {
          submitted = true;
          socket.end('{"error":"Request too large"}\n');
          return;
        }
        if (!text.includes("\n")) return;
        submitted = true;
        void (async () => {
          try {
            const body = JSON.parse(text.slice(0, text.indexOf("\n")));
            const abort = new AbortController();
            socket.once("close", () => abort.abort());
            if (body.capture !== undefined) {
              const outcome = await this.captureRequest(body.token, body.capture, abort.signal);
              socket.end(JSON.stringify(outcome) + "\n");
              return;
            }
            const result = await this.request(body.token, body.call, abort.signal);
            socket.end(JSON.stringify({ result }) + "\n");
          } catch {
            socket.end(
              '{"error":"Operation denied, expired, unavailable, or failed; no automatic retry"}\n',
            );
          }
        })();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      if (this.transport === "tcp") this.server.listen({ host: "127.0.0.1", port: 0 }, resolve);
      else this.server.listen(this.socketPath, resolve);
    });
    if (this.transport === "tcp") this.socketPath = `tcp://127.0.0.1:${this.server.address().port}`;
    else chmodSync(this.socketPath, 0o600);
  }
  request(token, value, signal) {
    const grant = this.grants.get(token);
    if (!grant || signal?.aborted || !this.permitted(grant.runId))
      return Promise.reject(new Error("Not permitted"));
    const call = normalizeCall(value);
    const step = actionStep(value);
    return this.requestCall(token, grant, call, signal, step);
  }
  /** Timings cover execution itself, excluding decision and human-approval waits. */
  async executeRecorded(driver, call, display, runId, context, step) {
    const started = this.now();
    try { return await this.execute(driver, call, display, runId, context); }
    finally {
      const label = step ?? ({ get_desktop_state: "Read the screen", click: "Click", type_text: "Type text", press_key: "Press a key", scroll: "Scroll" })[call.name];
      this.markStep(runId, label, Math.max(0, Math.round(this.now() - started)));
    }
  }
  /** Pending timing writes drain before stop, so the last action cannot disappear. */
  markStep(runId, label, durationMs) {
    const until = this.recordingUntil.get(runId);
    if (!label || !this.capture || until === undefined) return;
    if (this.now() > until + 30_000) { this.recordingUntil.delete(runId); return; }
    const pending = this.recordingSteps.get(runId) ?? new Set();
    const write = Promise.resolve().then(() => this.capture(runId, { action: "step", label, source: "action", durationMs: Math.min(durationMs, 300_000) }, AbortSignal.timeout(5_000)))
      .then(result => { if (result?.recorded === false) this.recordingTimingFailed.add(runId); })
      .catch(() => { this.recordingTimingFailed.add(runId); })
      .finally(() => { pending.delete(write); if (!pending.size) this.recordingSteps.delete(runId); });
    pending.add(write);
    this.recordingSteps.set(runId, pending);
  }
  requestCall(token, grant, call, signal, step) {
    const actionId = randomUUID();
    const assertLive = () => {
      if (this.suspended || signal?.aborted || this.grants.get(token) !== grant ||
          this.driver?.fingerprint !== grant.fingerprint || !this.permitted(grant.runId))
        throw new Error("Not permitted");
    };
    // Recheck at execution admission. The trusted execute callback also
    // enforces the live run, owner, display and policy fence; a workspace
    // deny is read again by `permitted` on every request.
    return Promise.resolve().then(() => {
      assertLive();
      return this.executeRecorded(this.driver, call, grant.display, grant.runId, { actionId, assertLive }, step);
    });
  }
  // Captures keep evidence for the person and return no desktop content to
  // the model, so they skip review; the grant and the run must still hold.
  async captureRequest(token, value, signal) {
    const grant = this.grants.get(token);
    if (!grant || signal?.aborted || !this.capture || !this.permitted(grant.runId))
      return { error: "Not permitted" };
    const call = normalizeCaptureCall(value);
    try {
      if (call.action === "stop_recording") {
        await Promise.all(this.recordingSteps.get(grant.runId) ?? []);
        if (this.recordingTimingFailed.has(grant.runId))
          await this.capture(grant.runId, { action: "step", label: "Recording timing incomplete", source: "action" }, signal);
      }
      const result = await this.capture(grant.runId, call, signal);
      // The broker keeps the recording window so it reports action steps only while one runs.
      if (call.action === "start_recording" && typeof result?.stopsAt === "string") {
        this.recordingUntil.set(grant.runId, Date.parse(result.stopsAt));
        this.recordingTimingFailed.delete(grant.runId);
      }
      if (call.action === "stop_recording") { this.recordingUntil.delete(grant.runId); this.recordingTimingFailed.delete(grant.runId); }
      return { result };
    } catch (error) {
      // Only the server's own fixed wording, never transport or provider detail.
      const detail = typeof error?.safeMessage === "string" ? error.safeMessage.slice(0, 300) : undefined;
      return { error: "Capture failed", ...(detail ? { detail } : {}) };
    }
  }
  revoke(token) {
    this.grants.delete(token);
  }
  // Revoke admission and pending reviews without deleting or closing resources.
  // An operation already handed to the driver cannot be undone here.
  suspend() {
    this.suspended = true;
    this.grants.clear();
  }
  async close() {
    this.suspend();
    for (const socket of this.sockets) socket.destroy();
    // Node unlinks the socket it owns on close. A failed bind owns nothing:
    // never unlink a path that may belong to another daemon or retained file.
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
  }
}
