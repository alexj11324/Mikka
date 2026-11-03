// Owned by dev:local. Immediate IPC refresh and periodic reconciliation share one queue.
import pg from 'pg'
import { assertDevLocal } from './guard.mjs'
import { refreshQueue } from './refresh-queue.mjs'
import { productSeedDeps, seedModelKeys, type SeedState } from './seed-model-keys'

async function main() {
  assertDevLocal(process.env)
  const apiKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  const pool = new pg.Pool({ connectionString: process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 })
  const deps = await productSeedDeps(pool)
  const { saveGitHubConnection } = await import('@/lib/github/connection')
  // This runner is loopback-only and already guarded by assertDevLocal. Give
  // only its synthetic account the synthetic user grant, sealed by real auth.
  const seedGitHub = async () => {
    const { rows } = await pool.query<{ userId: string }>(`SELECT a."userId" FROM account a
      LEFT JOIN github_connections g ON g."userId"=a."userId"
      WHERE a."providerId"='github' AND a."accountId"='4242' AND g."userId" IS NULL`)
    for (const { userId } of rows) await saveGitHubConnection(userId,
      { githubAccountId: '4242', githubLogin: 'mvp-owner-4242' }, { access_token: 'mvp-synthetic-installation-run' })
  }

  const state: SeedState = new Map()
  let running = Promise.resolve()
  const scan = refreshQueue(async () => {
    try { await seedGitHub(); await seedModelKeys(apiKey, deps, line => console.log(`dev:local ${line}`), state) }
    catch { console.log('dev:local local account setup unavailable; retrying later') }
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
