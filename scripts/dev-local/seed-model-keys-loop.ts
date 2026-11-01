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
  const state: SeedState = new Map()
  let running = Promise.resolve()
  const scan = refreshQueue(async () => {
    try { await seedModelKeys(apiKey, deps, line => console.log(`dev:local ${line}`), state) }
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
