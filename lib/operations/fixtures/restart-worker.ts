// Synthetic test child process only. Never imported by application code.
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createOperationLedger, type OperationIdentity } from '../ledger'

process.once('message', async (config: { url: string; identity: OperationIdentity; endpoint: string; mode: 'claim' | 'effect' | 'recover' }) => {
  const url = new URL(config.url), endpoint = new URL(config.endpoint)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/mikka_208_test' || endpoint.hostname !== '127.0.0.1') throw new Error('test loopback only')
  const pool = new Pool({ connectionString: config.url })
  // Process persistence test has no auth claim; separate HTTP test covers actual sessions.
  const ledger = createOperationLedger(pool, async () => {})
  try {
    if (config.mode === 'recover') {
      let refused = false
      try { await ledger.claim(config.identity, randomUUID()) } catch (error) { refused = error instanceof Error && error.message === 'operationAlreadyClaimed' }
      if (!refused) throw new Error('replay not refused')
      const row = await ledger.reconcile(config.identity, async record => {
        const response = await fetch(`${config.endpoint}/${record.idempotencyKey}`)
        if (response.status === 404) return null
        if (!response.ok) throw new Error('lookup failed')
        const { objectId } = await response.json()
        return { providerObjectId: objectId, evidenceDigest: createHash('sha256').update(objectId).digest('hex') }
      })
      process.send?.({ status: row.status, key: row.idempotencyKey, receipt: row.receipt })
      await pool.end(); process.disconnect?.()
    } else {
      const row = await ledger.claim(config.identity, randomUUID())
      if (config.mode === 'effect') {
        const response = await fetch(`${config.endpoint}/${row.idempotencyKey}`, { method: 'POST' })
        if (!response.ok) throw new Error('effect failed')
      }
      // Parent SIGKILLs here: committed claim, no receipt or graceful cleanup.
      process.send?.({ ready: true, key: row.idempotencyKey })
    }
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : 'worker error' })
    await pool.end(); process.exitCode = 1; process.disconnect?.()
  }
})
