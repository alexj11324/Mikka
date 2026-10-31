import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WriteProvider } from '../../lib/operations/write-contract'

/** An independent loopback effect service. It deliberately does not deduplicate
 * POSTs: a second call would produce a second effect and fail the assertions. */
export function recoveryHttpProvider(origin: string, afterEffect?: () => Promise<never>): WriteProvider {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw Error('loopback effect fixture required')
  return {
    name: 'local-recovery-fixture',
    async prepare() { return { accountId: 'fixture-account', version: 'fixture-v1' } },
    async execute(input) {
      await input.beforeSend()
      const response = await fetch(new URL('/effects', base), { method: 'POST', body: JSON.stringify({ key: input.idempotencyKey }), signal: input.signal })
      if (!response.ok) throw Error('effect fixture rejected request')
      const receipt = await response.json()
      if (afterEffect) await afterEffect()
      return receipt
    },
    async lookup(input) {
      const response = await fetch(new URL(`/effects/${input.idempotencyKey}`, base))
      if (!response.ok) throw Error('effect fixture readback failed')
      return response.json()
    },
  }
}

async function main() {
  const mode = process.argv[2]
  if (mode === 'server') {
    const effects = new Map<string, { providerObjectId: string; evidenceDigest: string }>()
    let posts = 0
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = new URL(request.url!, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/stats') return response.end(JSON.stringify({ posts, effects: effects.size }))
      if (request.method === 'GET' && /^\/effects\/[a-f0-9]{64}$/.test(url.pathname)) return response.end(JSON.stringify(effects.get(url.pathname.slice(9)) ?? null))
      if (request.method !== 'POST' || url.pathname !== '/effects') { response.statusCode = 404; return response.end('{}') }
      let body = ''
      for await (const part of request) { body += part; if (body.length > 512) { response.statusCode = 413; return response.end('{}') } }
      const value = JSON.parse(body)
      if (!/^[a-f0-9]{64}$/.test(value.key)) { response.statusCode = 422; return response.end('{}') }
      posts++
      const providerObjectId = randomUUID()
      const receipt = { providerObjectId, evidenceDigest: createHash('sha256').update(JSON.stringify([value.key, providerObjectId])).digest('hex') }
      effects.set(value.key, receipt)
      response.end(JSON.stringify(receipt))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('effect address unavailable')
    process.send?.({ kind: 'ready', origin: `http://127.0.0.1:${address.port}` })
    return
  }
  if (mode !== 'worker') throw Error('explicit fixture mode required')
  const { validateTarget } = await import('../../scripts/run-db-tests.mjs')
  validateTarget(process.env)
  const schema = process.env.OPERATION_RECOVERY_SCHEMA!
  if (!/^operation208_[a-f0-9]{32}$/.test(schema)) throw Error('invalid owned fixture schema')
  const [{ default: pg }, { createApprovedWrites }] = await Promise.all([
    import('pg'), import('../../lib/operations/approved-writes'),
  ])
  const pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, options: `-c search_path=${schema},pg_catalog`, max: 2 })
  try {
    const provider = recoveryHttpProvider(process.env.OPERATION_RECOVERY_ORIGIN!, async () => {
      process.send?.({ kind: 'effect-applied' })
      return new Promise<never>(() => {}) // Parent kills this process before receipt writeback.
    })
    await createApprovedWrites(pool, provider, 'append_notion_paragraph', { modelRun: {
      ownerId: 'recovery-owner', botId: null, workspaceId: null, runId: process.env.OPERATION_RECOVERY_RUN!,
    } }).proposeFromRun({ page_id: process.env.OPERATION_RECOVERY_PAGE!, text: 'Controlled local recovery effect' }, process.env.OPERATION_RECOVERY_INTENT!)
  } finally { await pool.end() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : 'operation fixture failed'); process.exitCode = 1 })
}
