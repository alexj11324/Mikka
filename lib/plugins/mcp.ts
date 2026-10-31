import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { PluginError, type PersonalPluginSnapshot } from './contracts'
import type { PersonalPluginStore } from './store'
import { publicMcpFetch } from './public-fetch'
import { abortable } from '@/lib/search/url-policy'

export type PersonalMcpCommand = { serverId: string; cursor?: string } | { serverId: string; name: string; arguments: Record<string, unknown> }

export function createPersonalMcpRuntime(store: Pick<PersonalPluginStore, 'mcpConnection'>, dependencies: {
  connect?: typeof createMCPClient; transport?: typeof publicMcpFetch;
} = {}) {
  return async (userId: string, snapshot: PersonalPluginSnapshot | undefined, command: PersonalMcpCommand) => {
    let client: MCPClient | undefined
    let transport: ReturnType<typeof publicMcpFetch> | undefined
    const signal = AbortSignal.timeout(25_000)
    let dispatched = false
    try {
      const entry = snapshot?.servers.find(server => server.id === command.serverId)
      if (snapshot && !entry) throw new PluginError('mcpNotEnabledForExecution', 403)
      const connection = await store.mcpConnection(userId, command.serverId, entry?.revision)
      transport = (dependencies.transport ?? publicMcpFetch)(new URL(connection.url).origin, signal)
      client = await (dependencies.connect ?? createMCPClient)({
        transport: { type: connection.transport, url: connection.url, headers: connection.headers, fetch: transport.fetch, redirect: 'error' },
        initializationOptions: { signal }, protocolVersionDiscovery: false, maxRetries: 0,
        onUncaughtError: () => {},
      })
      // A setting changed while the server initialized: do not dispatch with an old credential.
      await store.mcpConnection(userId, command.serverId, connection.revision)
      if ('name' in command) {
        dispatched = true
        const result = await abortable(() => client!.callTool({ name: command.name, arguments: command.arguments, options: { signal } }), signal)
        return redact(result, Object.values(connection.headers))
      }
      const result = await abortable(() => client!.listTools({ params: { cursor: command.cursor }, options: { signal } }), signal)
      // Server descriptions/schemas are untrusted tool evidence, never system instructions.
      return redact({ serverId: connection.id, tools: result.tools, nextCursor: result.nextCursor ?? null }, Object.values(connection.headers))
    } catch (error) {
      if (dispatched) return { error: 'mcpOutcomeUnknown' }
      return { error: error instanceof PluginError ? error.code : 'mcpUnavailable' }
    } finally {
      // Cleanup cannot replace a confirmed result with a retryable failure.
      if (client) await abortable(() => client!.close(), AbortSignal.timeout(2000)).catch(() => {})
      await transport?.close().catch(() => {})
    }
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
