import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { actionStep, normalizeCall, normalizeCaptureCall, executeDriver } from "./driver.mjs";
export class ComputerBroker {
  grants = new Map();
  // runId → when its screen recording stops by itself; only set while one runs.
  recordingUntil = new Map();
  pending = new Map();
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
    needsPerson,
  }) {
    Object.assign(this, { driver, socketPath, permitted, execute, capture, now, ttl, transport, needsPerson });
  }
  // runId → the last few action kinds, evidence for the Decisions API.
  recent = new Map();
  noteKind(runId, call) {
    const kinds = this.recent.get(runId) ?? [];
    const before = [...kinds];
    kinds.push(call.name);
    if (kinds.length > 8) kinds.shift();
    this.recent.set(runId, kinds);
    return before;
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
    return this.requestCall(token, grant, call, signal).then((result) => {
      this.markStep(grant.runId, step);
      return result;
    });
  }
  /** While this run records, a done action's description becomes a step on the recording (best effort; never fails the action). */
  markStep(runId, label) {
    const until = this.recordingUntil.get(runId);
    if (!label || !this.capture || until === undefined) return;
    if (this.now() > until) { this.recordingUntil.delete(runId); return; }
    void Promise.resolve().then(() => this.capture(runId, { action: "step", label, source: "action" })).catch(() => {});
  }
  requestCall(token, grant, call, signal) {
    const actionId = randomUUID();
    const assertLive = () => {
      if (this.suspended || signal?.aborted || this.grants.get(token) !== grant ||
          this.driver?.fingerprint !== grant.fingerprint || !this.permitted(grant.runId))
        throw new Error("Not permitted");
    };
    if (grant.permission === "allow") {
      // Recheck at execution admission. The trusted execute callback also
      // enforces the live run, owner, display and policy-version fence.
      return Promise.resolve().then(() => {
        assertLive();
        return this.execute(this.driver, call, grant.display, grant.runId, { actionId, assertLive });
      });
    }
    // Under `ask`, the Decisions API says whether this action needs the
    // person; no goes ahead, yes is reviewed, no answer goes ahead (logged).
    if (this.needsPerson) {
      const recent = this.noteKind(grant.runId, call);
      return Promise.resolve()
        .then(() => {
          assertLive();
          return this.needsPerson(grant.runId, { call, recent }, signal);
        })
        .catch((error) => {
          assertLive();
          if (signal?.aborted) throw error;
          return null;
        })
        .then((needsPerson) => {
          if (needsPerson === true) return this.review(token, grant, call, actionId, assertLive, signal);
          if (needsPerson !== false) console.warn(`Decision fallback: computer action ${call.name} executed without a judgment`);
          assertLive();
          return this.execute(this.driver, call, grant.display, grant.runId, { actionId, assertLive });
        });
    }
    return this.review(token, grant, call, actionId, assertLive, signal);
  }
  review(token, grant, call, actionId, assertLive, signal) {
    if (this.pending.size >= 20) return Promise.reject(new Error("Not permitted"));
    const request = {
      id: actionId,
      runId: grant.runId,
      target: this.driver.fingerprint,
      ...(grant.display === undefined ? {} : { display: grant.display }),
      call,
      expiresAt: this.now() + this.ttl,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        signal?.removeEventListener("abort", cancel);
        reject(new Error("Approval expired"));
      }, this.ttl);
      const cancel = () => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new Error("Model call cancelled; approval discarded"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(request.id, {
        token,
        assertLive,
        cleanup: () => signal?.removeEventListener("abort", cancel),
        request: { ...request, digest },
        resolve,
        reject,
        timer,
      });
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
      const result = await this.capture(grant.runId, call, signal);
      // The broker keeps the recording window so it reports action steps only while one runs.
      if (call.action === "start_recording" && typeof result?.stopsAt === "string") this.recordingUntil.set(grant.runId, Date.parse(result.stopsAt));
      if (call.action === "stop_recording") this.recordingUntil.delete(grant.runId);
      return { result };
    } catch (error) {
      // Only the server's own fixed wording, never transport or provider detail.
      const detail = typeof error?.safeMessage === "string" ? error.safeMessage.slice(0, 300) : undefined;
      return { error: "Capture failed", ...(detail ? { detail } : {}) };
    }
  }
  // Authenticated owner RPC or digest-bound web decisions call these methods.
  // The model-facing request socket deliberately has no decision/list method.
  list() {
    return [...this.pending.values()].map((p) => structuredClone(p.request));
  }
  revoke(token) {
    const revoked = this.grants.get(token);
    if (revoked) this.recent.delete(revoked.runId);
    this.grants.delete(token);
    for (const [id, row] of this.pending) {
      if (row.token !== token) continue;
      this.pending.delete(id);
      clearTimeout(row.timer);
      row.cleanup();
      row.reject(new Error("Run ended; approval discarded"));
    }
  }
  async decide(id, digest, approve) {
    const row = this.pending.get(id);
    if (!row) throw new Error("Request expired or already consumed");
    const left = Buffer.from(row.request.digest),
      right = Buffer.from(digest);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw new Error("Review changed");
    this.pending.delete(id);
    row.cleanup();
    clearTimeout(row.timer); // Claim BEFORE I/O. Never refund.
    const { runId, call, expiresAt, target, display } = row.request;
    if (
      !this.grants.has(row.token) ||
      !approve ||
      expiresAt <= this.now() ||
      target !== this.driver.fingerprint ||
      !this.permitted(runId)
    ) {
      row.reject(new Error("Not approved"));
      return { ok: true };
    }
    try {
      const assertLive = () => {
        row.assertLive();
        if (expiresAt <= this.now() || target !== this.driver?.fingerprint)
          throw new Error("Not permitted");
      };
      assertLive();
      row.resolve(await this.execute(this.driver, call, display, runId, { actionId: id, assertLive }));
    } catch (error) {
      row.reject(error);
    }
    return { ok: true };
  }
  // Revoke admission and pending reviews without deleting or closing resources.
  // An operation already handed to the driver cannot be undone here.
  suspend() {
    this.suspended = true;
    this.grants.clear();
    for (const row of this.pending.values()) {
      clearTimeout(row.timer);
      row.cleanup();
      row.reject(new Error("Daemon stopped; approval discarded"));
    }
    this.pending.clear();
  }
  async close() {
    this.suspend();
    for (const socket of this.sockets) socket.destroy();
    // Node unlinks the socket it owns on close. A failed bind owns nothing:
    // never unlink a path that may belong to another daemon or retained file.
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
  }
}
