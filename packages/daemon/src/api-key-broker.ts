// Host-side broker for a cloud run's API key (orchestration.md § 6). The task
// container gets one Unix socket and a placeholder, never the key: requests go
// only to the run's own provider, on its model paths, with the key added here.
// The key lives in this closure until the run ends; nothing is written down
// or logged.
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import type { RunCredential } from "./agents/run-credential";

const DEFAULT_BASE = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" } as const;
/** What the CLIs send for a model turn, by protocol; nothing else reaches the provider. */
const PATHS = {
  anthropic: new Set(["/v1/messages", "/v1/messages/count_tokens"]),
  openai: new Set(["/responses", "/responses/compact"]),
} as const;
const FORWARD = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent"];
const RETURN = ["content-type", "retry-after", "request-id", "x-request-id"];
const MAX_BODY = 32 * 1024 * 1024;

export async function createApiKeyBroker(host: {
  root: string;
  protocol: "anthropic" | "openai";
  credential: RunCredential;
  /** The run is still live; called before each request. */
  check(): Promise<unknown>;
  fetch?: typeof fetch;
}) {
  const { credential, protocol } = host;
  if (credential.kind === "provider" && credential.protocol !== protocol) throw new Error("api_key_broker_unavailable");
  const base = new URL(credential.kind === "provider" ? credential.baseUrl : DEFAULT_BASE[protocol]);
  if (base.protocol !== "https:" || base.username || base.password || !credential.key || /[\r\n\0]/.test(credential.key))
    throw new Error("api_key_broker_unavailable");
  const origin = base.href.replace(/\/+$/, "");
  let key: string | undefined = credential.key;
  const send = host.fetch ?? fetch;
  await host.check();
  mkdirSync(host.root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(host.root, "api-key-broker-"));
  chmodSync(dir, 0o700);
  const socket = join(dir, "broker.sock");
  const pending = new Set<AbortController>();
  let halted = false;
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    pending.add(abort);
    response.on("close", () => { if (!response.writableFinished) abort.abort(); });
    try {
      const url = new URL(request.url ?? "/", "http://broker");
      if (halted || !key || request.method !== "POST" || (request.url ?? "").length > 256 || !PATHS[protocol].has(url.pathname)
        || (url.search && url.search !== "?beta=true")) {
        response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" }).end('{"error":"not_found"}');
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const part of request) {
        length += part.length;
        if (length > MAX_BODY) throw new Error("request refused");
        chunks.push(part);
      }
      await host.check();
      if (halted || !key || abort.signal.aborted) throw new Error("request refused");
      const headers: Record<string, string> = {};
      for (const name of FORWARD) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      // The CLI's placeholder login is not the key's: drop its OAuth beta.
      if (headers["anthropic-beta"]) {
        const betas = headers["anthropic-beta"].split(",").map(item => item.trim()).filter(item => item && !item.startsWith("oauth-"));
        if (betas.length) headers["anthropic-beta"] = betas.join(",");
        else delete headers["anthropic-beta"];
      }
      if (protocol === "anthropic") headers["x-api-key"] = key;
      else headers.authorization = `Bearer ${key}`;
      const upstream = await send(origin + url.pathname + url.search, {
        method: "POST", headers, body: Buffer.concat(chunks), redirect: "error", signal: abort.signal, cache: "no-store",
      });
      const returned: Record<string, string> = { "cache-control": "no-store" };
      for (const name of RETURN) {
        const value = upstream.headers.get(name);
        if (value) returned[name] = value;
      }
      response.writeHead(upstream.status, returned);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (abort.signal.aborted) throw new Error("request cancelled");
            if (!response.write(value)) await once(response, "drain", { signal: abort.signal });
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      response.end();
    } catch {
      // A fixed local error: never the provider's or the key's details.
      abort.abort();
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ type: "error", error: { type: "api_key_unavailable", message: "API key unavailable" } }));
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
    key = undefined;
    rmSync(dir, { recursive: true, force: true });
    throw new Error("api_key_broker_unavailable");
  }
  return {
    socket,
    async close() {
      halted = true;
      key = undefined;
      for (const abort of pending) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
