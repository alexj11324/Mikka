import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { PluginError, type PersonalPluginSnapshot } from './contracts'
import type { PersonalPluginStore } from './store'
import { publicMcpFetch } from './public-fetch'
import { abortable } from '@/lib/search/url-policy'

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
  try {
    const connection = await target()
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
    return redact({ tools: result.tools, nextCursor: result.nextCursor ?? null }, connection.secrets)
  } catch (error) {
    if (dispatched) return { error: 'mcpOutcomeUnknown' }
    const code = hooks.code?.(error)
    if (code) return { error: code }
    console.warn(JSON.stringify({ event: 'mcp_unavailable', ...mcpFailure(error, stage, host) }))
    return { error: 'mcpUnavailable' }
  } finally {
    // Cleanup cannot replace a confirmed result with a retryable failure.
    if (client) await abortable(() => client!.close(), AbortSignal.timeout(2000)).catch(() => {})
    await transport?.close().catch(() => {})
  }
}

type McpStage = 'target' | 'connect' | 'ready' | 'list' | 'call'

/**
 * Why an MCP setup failed, as codes only: the stage, the server host, the HTTP
 * status the SDK reports ("(HTTP 401)") and the network error code
 * (ECONNRESET…). Never the message text, headers or body, which could carry a
 * credential.
 */
export function mcpFailure(error: unknown, stage: McpStage, host?: string) {
  const message = error instanceof Error ? error.message : ''
  const status = Number(/\(HTTP (\d{3})\)/.exec(message)?.[1]) || undefined
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  const errorCode = typeof cause === 'string' && /^[A-Z_]{2,40}$/.test(cause) ? cause : undefined
  const errorName = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown'
  return { stage, host, status, errorName, errorCode }
}

export function createPersonalMcpRuntime(store: Pick<PersonalPluginStore, 'mcpConnection'>, dependencies: McpDependencies = {}) {
  return async (userId: string, snapshot: PersonalPluginSnapshot | undefined, command: PersonalMcpCommand) => {
    let revision: number | undefined
    const result = await runMcpCommand(async () => {
      const entry = snapshot?.servers.find(server => server.id === command.serverId)
      if (snapshot && !entry) throw new PluginError('mcpNotEnabledForExecution', 403)
      const connection = await store.mcpConnection(userId, command.serverId, entry?.revision)
      revision = connection.revision
      return { url: connection.url, transport: connection.transport, headers: connection.headers, secrets: Object.values(connection.headers) }
    }, command, dependencies, {
      // A setting changed while the server initialized: do not dispatch with an old credential.
      ready: () => store.mcpConnection(userId, command.serverId, revision),
      code: error => error instanceof PluginError ? error.code : undefined,
    })
    return 'name' in command || 'error' in result ? result : { serverId: command.serverId, ...result }
  }
}

function redact<T>(result: T, secrets: string[]): T {
  // A server can echo headers in its result. Never persist those literal values.
  const needles = secrets.flatMap(secret => [secret, secret.replace(/^Bearer\s+/i, ''), Buffer.from(secret).toString('base64')]).filter(Boolean).sort((a,b) => b.length-a.length)
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return needles.reduce((text, needle) => text.split(needle).join('[redacted]'), value)
    if (Array.isArray(value)) return value.map(mask)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [mask(key), mask(part)]))
    return value
  }
  return mask(result) as T
}
