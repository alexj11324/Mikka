import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { normalizeCall, executeDriver } from "./driver.mjs";
export class ComputerBroker {
  grants = new Map();
  pending = new Map();
  sockets = new Set();
  constructor({
    driver,
    socketPath,
    permitted,
    execute = (driver, call, display) => executeDriver(driver, call, display),
    now = Date.now,
    ttl = 300000,
  }) {
    Object.assign(this, { driver, socketPath, permitted, execute, now, ttl });
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
    if (!this.driver || !permission || !["ask", "allow"].includes(permission))
      return undefined;
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, { runId, fingerprint: this.driver.fingerprint, display, permission });
    return { socketPath: this.socketPath, token };
  }
  async listen() {
    rmSync(this.socketPath, { force: true });
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
      this.server.listen(this.socketPath, resolve);
    });
    chmodSync(this.socketPath, 0o600);
  }
  request(token, value, signal) {
    const grant = this.grants.get(token);
    if (!grant || signal?.aborted || !this.permitted(grant.runId))
      return Promise.reject(new Error("Not permitted"));
    const call = normalizeCall(value);
    const actionId = randomUUID();
    if (grant.permission === "allow") {
      // Recheck at execution admission. The trusted execute callback also
      // enforces the live run, owner, display and policy-version fence.
      return Promise.resolve().then(() => {
        if (signal?.aborted || this.grants.get(token) !== grant ||
            this.driver?.fingerprint !== grant.fingerprint || !this.permitted(grant.runId))
          throw new Error("Not permitted");
        return this.execute(this.driver, call, grant.display, grant.runId, { actionId });
      });
    }
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
        cleanup: () => signal?.removeEventListener("abort", cancel),
        request: { ...request, digest },
        resolve,
        reject,
        timer,
      });
    });
  }
  // Authenticated owner RPC or digest-bound web decisions call these methods.
  // The model-facing request socket deliberately has no decision/list method.
  list() {
    return [...this.pending.values()].map((p) => structuredClone(p.request));
  }
  revoke(token) {
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
      row.resolve(await this.execute(this.driver, call, display, runId, { actionId: id }));
    } catch (error) {
      row.reject(error);
    }
    return { ok: true };
  }
  async close() {
    this.grants.clear();
    for (const row of this.pending.values()) {
      clearTimeout(row.timer);
      row.cleanup();
      row.reject(new Error("Daemon stopped; approval discarded"));
    }
    this.pending.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    rmSync(this.socketPath, { force: true });
  }
}
