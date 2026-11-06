// Host-side broker: the native runtime receives one Unix socket, never vault
// identities or provider credentials. No TCP listener or arbitrary upstream URL.
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import type { SubscriptionWorkerClient } from "./subscription-worker-client";
import type { Logger } from "./log";

// Public protocol marker; authority comes from the private task socket.
export const NATIVE_AUTH_PLACEHOLDER = "mikka-native-broker-placeholder";

export async function createNativeSubscriptionBroker(host: {
  root: string;
  revision: number;
  /** Optional already-validated startup metadata; only used to open the private socket. */
  prepare?(): Promise<unknown>;
  check(): Promise<unknown>;
  log?: Pick<Logger, 'warn'>;
  worker: Pick<SubscriptionWorkerClient, "nativeRequest">;
}) {
  await (host.prepare ? host.prepare() : host.check());
  mkdirSync(host.root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(host.root, "native-broker-"));
  chmodSync(dir, 0o700);
  const socket = join(dir, "broker.sock");
  const pending = new Set<AbortController>();
  let closed = false;
  let firstFailureReported = false;
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    pending.add(abort);
    response.on("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    let phase: 'request_headers' | 'body_read' | 'body_parse' | 'authorize' | 'upstream_request' | 'upstream_stream' = 'request_headers';
    let length = 0;
    try {
      if (
        closed ||
        request.method !== "POST" ||
        !request.url ||
        request.url.length > 128
      )
        throw new Error("request refused");
      const chunks: Buffer[] = [];
      phase = 'body_read';
      for await (const part of request) {
        length += part.length;
        if (length > 262144) throw new Error("request refused");
        chunks.push(part);
      }
      phase = 'body_parse';
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      phase = 'authorize';
      await host.check();
      if (closed || abort.signal.aborted) throw new Error("request refused");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers))
        if (typeof value === "string") headers[key] = value;
      phase = 'upstream_request';
      const upstream = await host.worker.nativeRequest(
        host.revision,
        { path: request.url, headers, body },
        abort.signal,
      );
      response.writeHead(200, {
        "content-type": upstream.contentType,
        "cache-control": "no-store",
      });
      phase = 'upstream_stream';
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (abort.signal.aborted) throw new Error("request cancelled");
          if (!response.write(value))
            await once(response, "drain", { signal: abort.signal });
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      response.end();
    } catch {
      // Fail this request only. The native CLI owns its bounded retries;
      // each later request must pass fresh authority, never a cached grant.
      if (!firstFailureReported) {
        firstFailureReported = true;
        try { host.log?.warn({ event: 'subscription_native_broker_failure', phase, body_bytes: length,
          status_class: response.headersSent ? 'stream_aborted' : 'local_503' }, 'Native subscription request failed'); }
        catch { /* Diagnostics never change the fixed refusal. */ }
      }
      abort.abort();
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(503, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(
            JSON.stringify({
              type: "error",
              error: {
                type: "subscription_unavailable",
                message: "Subscription unavailable",
              },
            }),
          );
    } finally {
      pending.delete(abort);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    chmodSync(socket, 0o600);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("native_broker_unavailable");
  }
  return {
    socket,
    async close() {
      closed = true;
      for (const abort of pending) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
