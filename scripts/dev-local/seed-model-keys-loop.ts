// Owned by dev:local. Immediate IPC refresh and periodic reconciliation share one queue.
import pg from 'pg'
import { assertDevLocal } from './guard.mjs'
import { refreshQueue } from './refresh-queue.mjs'
import { productSeedDeps, seedModelKeys, type SeedState } from './seed-model-keys'

async function main() {
  assertDevLocal(process.env)
  const { installDevLocalTransport } = await import('./transport.mjs')
  installDevLocalTransport()
  const apiKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const pool = new pg.Pool({ connectionString: process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 })
  const deps = await productSeedDeps(pool)
  const { saveGitHubConnection } = await import('@/lib/github/connection')
  const seedGitHub = async () => {
    // Existing dev:local fixture identity only. This is a sealed synthetic user
    // token for the loopback provider, never an installation or production grant.
    const { rows } = await pool.query(`SELECT a."userId" FROM account a LEFT JOIN github_connections c ON c."userId"=a."userId"
      WHERE a."providerId"='github' AND a."accountId"='4242' AND c."userId" IS NULL`)
    for (const row of rows) await saveGitHubConnection(row.userId,{githubAccountId:'4242',githubLogin:'mvp-owner-4242'},{access_token:'mikka-local-synthetic-user-token'})
  }
  const state: SeedState = new Map()
  let running = Promise.resolve()
  const scan = refreshQueue(async () => {
    try { await seedGitHub(); await seedModelKeys(apiKey, deps, line => console.log(`dev:local ${line}`), state) }
    catch { console.log('dev:local model key setup unavailable; retrying later') }
  })
  const tick = () => running = scan()
  let interval: ReturnType<typeof setInterval> | undefined
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    clearInterval(interval)
    const timer = setTimeout(() => process.exit(0), 3000)
    void running.then(() => pool.end()).finally(() => { clearTimeout(timer); process.exit(0) })
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop)
  process.on('message', (message: unknown) => {
    const request = message as { type?: string; id?: string }
    if (request.type === 'refresh') void tick().then(() => process.send?.({ type: 'refreshed', id: request.id }))
  })
  await tick()
  process.send?.({ type: 'ready' })
  let periodic: Promise<void> | undefined
  interval = setInterval(() => { periodic ??= tick().finally(() => { periodic = undefined }) }, 5000)
}
void main()
