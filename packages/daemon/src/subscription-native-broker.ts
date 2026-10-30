// Host-side broker: the native runtime receives one Unix socket, never vault
// identities or provider credentials. No TCP listener or arbitrary upstream URL.
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import type { SubscriptionWorkerClient } from "./subscription-worker-client";

// Public protocol marker; authority comes from the private task socket.
export const NATIVE_AUTH_PLACEHOLDER = "mikka-native-broker-placeholder";

export async function createNativeSubscriptionBroker(host: {
  root: string;
  revision: number;
  check(): Promise<unknown>;
  worker: Pick<SubscriptionWorkerClient, "nativeRequest">;
  retainResources?: boolean;
}) {
  await host.check();
  mkdirSync(host.root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(host.root, "native-broker-"));
  chmodSync(dir, 0o700);
  const socket = join(dir, "broker.sock");
  const pending = new Set<AbortController>();
  let halted = false;
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    pending.add(abort);
    response.on("close", () => {
      if (!response.writableFinished) abort.abort();
    });
    try {
      if (
        halted ||
        request.method !== "POST" ||
        !request.url ||
        request.url.length > 128
      )
        throw new Error("request refused");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const part of request) {
        length += part.length;
        if (length > 262144) throw new Error("request refused");
        chunks.push(part);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await host.check();
      if (halted || abort.signal.aborted) throw new Error("request refused");
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers))
        if (typeof value === "string") headers[key] = value;
      const upstream = await host.worker.nativeRequest(
        host.revision,
        { path: request.url, headers, body },
        abort.signal,
      );
      response.writeHead(200, {
        "content-type": upstream.contentType,
        "cache-control": "no-store",
      });
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
      // No replay after a provider/store/transport outcome is uncertain. Native
      // client retries can receive only this fixed local error for the session.
      halted = true;
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
    if (!host.retainResources) rmSync(dir, { recursive: true, force: true });
    throw new Error("native_broker_unavailable");
  }
  return {
    socket,
    async close() {
      halted = true;
      for (const abort of pending) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!host.retainResources) rmSync(dir, { recursive: true, force: true });
    },
  };
}
