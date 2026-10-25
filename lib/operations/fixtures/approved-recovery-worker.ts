// Separate-process acceptance fixture. Loopback only; recovery must never send.
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
process.once('message', async (config: { url: string; endpoint: string; owner: string; sessionId: string; id: string; missing: boolean }) => {
  const url = new URL(config.url), endpoint = new URL(config.endpoint)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/mikka_208_test' || endpoint.hostname !== '127.0.0.1') throw new Error('loopback only')
  if (process.env.COMPOSIO_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL) throw new Error('isolated only')
  process.env.MIKKA_DATABASE_URL = config.url
  const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { url: 'data:text/javascript,export{}', shortCircuit: true } : next(specifier, context) } })
  const database = await import('../../db/request-scope'), scope = database.createRequestDatabaseScope(config.url)
  try {
    const { withCalendarTestProvider } = await import('../calendar-runtime')
    const { decidePendingAction } = await import('../../pending-actions')
    let executeAttempts = 0
    const provider = {
      name: 'synthetic-calendar-http', prepare: async () => ({ accountId: 'fixture-account', version: 'fixture-v1' }),
      execute: async (): Promise<never> => { executeAttempts++; throw new Error('recovery attempted a write') },
      lookup: async (input: { idempotencyKey: string }) => {
        if (config.missing) return null
        const response = await fetch(`${config.endpoint}/${input.idempotencyKey}`)
        if (response.status === 404) return null
        if (!response.ok) throw new Error('lookup failed')
        const { id } = await response.json()
        return { providerObjectId: id, evidenceDigest: createHash('sha256').update(id).digest('hex') }
      },
    }
    const result = await scope.run(() => withCalendarTestProvider(provider, () => decidePendingAction(config.owner, config.id, true, config.sessionId)))
    process.send?.({ status: result.status, executeAttempts })
  } catch (error) { process.send?.({ error: error instanceof Error ? error.message : 'recovery failed' }); process.exitCode = 1 }
  finally { hooks.deregister(); await scope.close(); await database.pool.end(); process.disconnect?.() }
})
