// Daemon-owned backend transport. Platform run tokens never enter CLI config or tool arguments.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";

const names = new Set([
  "prepare_credential_request",
  "credential_status",
  "credential_use",
  "credential_browser_action",
  "credential_finish",
]);
type Grant = {
  privateDir: string;
  runId: string;
  url: string;
  token: string;
  capability: string;
  server: Server;
  isLive: () => boolean;
  session?: string;
  seq: number;
  initialization?: Promise<void>;
  references: Set<string>;
  abort: AbortController;
  timer?: ReturnType<typeof setInterval>;
};
const grants = new Map<string, Grant>();
const key = (privateDir: string, runId: string) =>
  `${realpathSync(privateDir)}\0${runId}`;

function headers(grant: Grant) {
  return {
    Authorization: `Bearer ${grant.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(grant.session ? { "mcp-session-id": grant.session } : {}),
  };
}
async function rpc(
  grant: Grant,
  method: string,
  params: unknown,
  timeout = 45_000,
): Promise<Record<string, unknown>> {
  const id = ++grant.seq;
  const response = await fetch(grant.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(timeout), grant.abort.signal]),
    headers: headers(grant),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("credential_backend_unavailable");
  }
  grant.session = response.headers.get("mcp-session-id") ?? grant.session;
  const text = await response.text();
  if (text.length > 524288 || text.includes(grant.token))
    throw new Error("credential_backend_response_rejected");
  const messages = text.trim().startsWith("{")
    ? [JSON.parse(text)]
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)));
  const result = messages.find((message) => message.id === id);
  if (!result?.result || result.error)
    throw new Error("credential_backend_unavailable");
  return result.result;
}
function initialize(grant: Grant) {
  return (grant.initialization ??= (async () => {
    await rpc(grant, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mikka-daemon-credential-bridge", version: "1" },
    });
    const response = await fetch(grant.url, {
      method: "POST",
      redirect: "error",
      headers: headers(grant),
      signal: AbortSignal.any([AbortSignal.timeout(5000), grant.abort.signal]),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("credential_backend_unavailable");
  })().catch(error => {
    grant.initialization = undefined;
    grant.session = undefined;
    throw error;
  }));
}
export function credentialBridgeFor(privateDir: string, runId: string) {
  const grant = grants.get(key(privateDir, runId));
  if (!grant || !grant.isLive()) return undefined;
  const address = grant.server.address();
  if (!address || typeof address === "string") return undefined;
  // Agent-visible local capability, scoped to one run and five secret-free tools; NOT platform auth.
  return `http://127.0.0.1:${address.port}/${grant.capability}`;
}
export async function registerCredentialBridge(options: {
  privateDir: string;
  runId: string;
  mcp?: { url: string; token: string };
  isLive: () => boolean;
}) {
  if (!options.mcp) return;
  const url = new URL(options.mcp.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("credential_bridge_origin_invalid");
  const id = key(options.privateDir, options.runId),
    previous = grants.get(id);
  if (previous) {
    if (previous.timer) clearInterval(previous.timer);
    previous.abort.abort();
    previous.server.closeAllConnections();
    previous.server.close();
  }
  const grant = {
    privateDir: realpathSync(options.privateDir),
    runId: options.runId,
    url: url.href,
    token: options.mcp.token,
    capability: randomBytes(32).toString("base64url"),
    isLive: options.isLive,
    seq: 0,
    references: new Set<string>(),
    abort: new AbortController(),
  } as Grant;
  grant.server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (
      request.method !== "POST" ||
      request.url !== `/${grant.capability}` ||
      request.headers.origin ||
      request.headers["x-mikka-credential-bridge"] !== "1" ||
      !grant.isLive()
    ) {
      response.writeHead(403);
      response.end('{"error":"credential_bridge_denied"}');
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 32768) throw new Error();
      }
      const input = JSON.parse(body);
      if (
        input.method !== "tools/list" &&
        (input.method !== "tools/call" || !names.has(input.params?.name))
      )
        throw new Error();
      if (
        input.params?.arguments?.runId &&
        input.params.arguments.runId !== grant.runId
      )
        throw new Error();
      if (
        input.method === "tools/call" &&
        /^[a-f0-9-]{36}$/.test(input.params.arguments?.credentialRef) &&
        grant.references.size < 32
      )
        grant.references.add(input.params.arguments.credentialRef);
      await initialize(grant);
      const result = await rpc(grant, input.method, input.params ?? {});
      if (input.method === "tools/list")
        result.tools = (result.tools as { name: string }[]).filter((tool) =>
          names.has(tool.name),
        );
      if (!grant.isLive()) throw new Error();
      response.end(JSON.stringify(result));
    } catch {
      if (!response.destroyed) {
        response.writeHead(503);
        response.end('{"error":"credential_bridge_unavailable"}');
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    grant.server.once("error", reject);
    grant.server.listen(0, "127.0.0.1", resolve);
  });
  grant.server.unref();
  grants.set(id, grant);
  grant.timer = setInterval(() => {
    if (grant.isLive()) return;
    if (grant.timer) clearInterval(grant.timer);
    if (grants.get(id) === grant) grants.delete(id);
    grant.abort.abort();
    grant.server.closeAllConnections();
    grant.server.close();
    grant.token = "";
  }, 5000);
  grant.timer.unref();
}
export async function closeCredentialBridges(privateDir: string) {
  const owner = realpathSync(privateDir);
  for (const [id, grant] of grants) {
    if (grant.privateDir !== owner) continue;
    grants.delete(id);
    if (grant.timer) clearInterval(grant.timer);
    await Promise.allSettled(
      [...grant.references].map((reference) =>
        rpc(
          grant,
          "tools/call",
          {
            name: "credential_finish",
            arguments: { credentialRef: reference },
          },
          5000,
        ),
      ),
    );
    grant.abort.abort();
    grant.server.closeAllConnections();
    await new Promise<void>((resolve) => grant.server.close(() => resolve()));
    grant.token = "";
  }
}
