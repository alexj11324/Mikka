// Spawned by scripts/dev-local.mjs (tsx, server-only shim). Every 5 s seeds the
// DeepSeek key for accounts that have none. DEEPSEEK_API_KEY lives only in env.
import pg from 'pg'
import { assertDevLocal } from './guard.mjs'
import { productSeedDeps, seedModelKeys } from './seed-model-keys'

assertDevLocal(process.env)
const apiKey = process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_API_KEY
const pool = new pg.Pool({ connectionString: process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 })
const deps = await productSeedDeps(pool)
const tick = async () => {
  try { await seedModelKeys(apiKey, deps, line => console.log(`dev:local ${line}`)) }
  catch (error) { console.log(`dev:local model key seed failed: ${(error as Error).message.split(apiKey ?? '\u0000').join('<key>')}`) }
}
await tick()
setInterval(() => { void tick() }, 5000)
