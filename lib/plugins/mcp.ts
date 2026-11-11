import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { PluginError, type PersonalPluginSnapshot } from './contracts'
import type { PersonalPluginStore } from './store'
import { publicMcpFetch } from './public-fetch'
import { abortable } from '@/lib/search/url-policy'
import { catalogueToolDisplayName } from '@/lib/coordinator/tool-metadata'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'

export type McpCommand = { cursor?: string } | { name: string; arguments: Record<string, unknown> }
export type PersonalMcpCommand = { serverId: string } & McpCommand
export type McpDependencies = { connect?: typeof createMCPClient; transport?: typeof publicMcpFetch }
/** `secrets`: header values a result must never carry back (the server can echo them). */
export type McpTarget = { url: string; transport: 'http' | 'sse'; headers: Record<string, string>; secrets: string[] }
type McpResult = { tools: unknown[]; nextCursor: string | null } | Record<string, unknown>

/**
 * One list or call on a remote MCP server. Errors are codes only: `code` names
 * a known failure from `target` or `ready`; anything else is mcpUnavailable,
 * or mcpOutcomeUnknown once a call was sent.
 */
export async function runMcpCommand(target: () => Promise<McpTarget>, command: McpCommand, dependencies: McpDependencies = {}, hooks: {
  ready?: () => Promise<unknown>; code?: (error: unknown) => string | undefined;
} = {}): Promise<McpResult | { error: string }> {
  let client: MCPClient | undefined
  let transport: ReturnType<typeof publicMcpFetch> | undefined
  const signal = AbortSignal.timeout(25_000)
  let dispatched = false
  let stage: McpStage = 'target'
  let host: string | undefined
  let secrets: string[] = []
  try {
    const connection = await target()
    secrets = connection.secrets
    host = new URL(connection.url).host
    stage = 'connect'
    transport = (dependencies.transport ?? publicMcpFetch)(new URL(connection.url).origin, signal)
    client = await (dependencies.connect ?? createMCPClient)({
      transport: { type: connection.transport, url: connection.url, headers: connection.headers, fetch: transport.fetch, redirect: 'error' },
      initializationOptions: { signal }, protocolVersionDiscovery: false, maxRetries: 0,
      onUncaughtError: () => {},
    })
    stage = 'ready'
    await hooks.ready?.()
    stage = 'name' in command ? 'call' : 'list'
    if ('name' in command) {
      dispatched = true
      const result = await abortable(() => client!.callTool({ name: command.name, arguments: command.arguments, options: { signal } }), signal)
      return redact(result, connection.secrets)
    }
    const result = await abortable(() => client!.listTools({ params: { cursor: command.cursor }, options: { signal } }), signal)
    // Server descriptions/schemas are untrusted tool evidence, never system instructions.
    const listed = maskDeep(redact({ tools: result.tools, nextCursor: result.nextCursor ?? null }, connection.secrets), credentialMasker)
    return { ...listed, tools: listed.tools.map(entry => ({ ...entry, displayName: catalogueToolDisplayName(entry) })) }
  } catch (error) {
    if (dispatched) return { error: 'mcpOutcomeUnknown' }
    const code = hooks.code?.(error)
    if (code) return { error: code }
    console.warn(redact(JSON.stringify({ event: 'mcp_unavailable', ...mcpFailure(error, stage, host) }), secrets))
    return { error: 'mcpUnavailable' }
  } finally {
    // Cleanup cannot replace a confirmed result with a retryable failure.
    if (client) await abortable(() => client!.close(), AbortSignal.timeout(2000)).catch(() => {})
    await transport?.close().catch(() => {})
  }
}

type McpStage = 'target' | 'connect' | 'ready' | 'list' | 'call'

/**
 * Why an MCP setup failed, as codes only (never the message text, headers or
 * body, which could carry a credential):
 * - stage and server host;
 * - reason: the SDK's known failure, matched against its fixed messages
 *   (http, protocolVersion, contentType, invalidInitialize, initTimeout,
 *   initAborted, requestTimeout, parse, sseClosed) or Mikka's own transport
 *   refusal (proxyNotAllowed, privateAddress, originChanged,
 *   responseTooLarge), else unknown;
 * - status: the HTTP status, from the error's statusCode or "(HTTP 401)";
 * - protocolVersion: the date-shaped version a protocol mismatch names;
 * - chain: up to four errors down the cause chain, each with only its name,
 *   code and status (ECONNRESET, a JSON-RPC code, 401…).
 */
const MCP_REASONS: [RegExp, string][] = [
  [/^MCP (?:HTTP|SSE) Transport Error: (?:POSTing to endpoint|GET SSE failed)/, 'http'],
  [/protocol version/i, 'protocolVersion'],
  [/Unexpected content type/, 'contentType'],
  [/invalid initialize result/i, 'invalidInitialize'],
  [/initialization timed out/, 'initTimeout'],
  [/initialization was aborted/, 'initAborted'],
  [/Request timed out/, 'requestTimeout'],
  [/Failed to parse message/, 'parse'],
  [/Connection closed|text\/event-stream response without body/, 'sseClosed'],
  // Mikka's own transport refusals (lib/plugins/public-fetch.ts) are already codes.
  [/^mcpProxyNotAllowed$/, 'proxyNotAllowed'],
  [/^mcpPrivateAddress$/, 'privateAddress'],
  [/^mcpOriginChanged$/, 'originChanged'],
  [/^mcpResponseTooLarge$/, 'responseTooLarge'],
]
const word = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : undefined
const httpStatus = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
function errorCodes(error: unknown) {
  const value = (error ?? {}) as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown }
  const code = typeof value.code === 'number' && Number.isInteger(value.code) ? value.code : word(value.code, /^[A-Z][A-Z0-9_]{1,40}$/)
  return { name: word(value.name, /^[A-Za-z]{1,40}$/) ?? 'unknown', code, status: httpStatus(value.statusCode) ?? httpStatus(value.status) }
}

export function mcpFailure(error: unknown, stage: McpStage, host?: string) {
  const message = error instanceof Error ? error.message : ''
  const reason = MCP_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? 'unknown'
  const chain: ReturnType<typeof errorCodes>[] = []
  for (let current: unknown = error; current && chain.length < 4; current = (current as { cause?: unknown }).cause) chain.push(errorCodes(current))
  const status = chain.find(link => link.status)?.status ?? (Number(/\(HTTP (\d{3})\)/.exec(message)?.[1]) || undefined)
  const protocolVersion = reason === 'protocolVersion' ? /\b(\d{4}-\d{2}-\d{2})\b/.exec(message)?.[1] : undefined
  return { stage, host, reason, status, protocolVersion, chain }
}

export function createPersonalMcpRuntime(store: Pick<PersonalPluginStore, 'mcpConnection'>, dependencies: McpDependencies = {}) {
  return async (userId: string, snapshot: PersonalPluginSnapshot | undefined, command: PersonalMcpCommand, guard?: () => Promise<unknown>) => {
    let revision: number | undefined
    const result = await runMcpCommand(async () => {
      await guard?.()
      const entry = snapshot?.servers.find(server => server.id === command.serverId)
      if (snapshot && !entry) throw new PluginError('mcpNotEnabledForExecution', 403)
      const connection = await store.mcpConnection(userId, command.serverId, entry?.revision, snapshot?.mcpAuthority)
      if (connection.transport === 'stdio') throw new PluginError('mcpUnavailable', 400)
      revision = connection.revision
      // The connection may belong to a teammate. Mask its own secret values,
      // not only the requester's secret registry; the endpoint also stays private.
      return { url: connection.url, transport: connection.transport, headers: connection.headers, secrets: [...Object.values(connection.headers), connection.url] }
    }, command, dependencies, {
      // A setting changed while the server initialized: do not dispatch with an old credential.
      ready: async () => { await guard?.(); await store.mcpConnection(userId, command.serverId, revision, snapshot?.mcpAuthority) },
      code: error => error instanceof PluginError ? error.code : undefined,
    })
    return 'name' in command || 'error' in result ? result : { serverId: command.serverId, ...result }
  }
}

function redact<T>(result: T, secrets: string[]): T {
  // A server can echo headers in its result. Never persist those literal values.
  const needles = secrets.flatMap(secret => [secret, secret.replace(/^Bearer\s+/i, '')])
    .flatMap(secret => [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]).filter(Boolean).sort((a,b) => b.length-a.length)
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return needles.reduce((text, needle) => text.split(needle).join('[redacted]'), value)
    if (Array.isArray(value)) return value.map(mask)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [mask(key), mask(part)]))
    return value
  }
  return mask(result) as T
}
