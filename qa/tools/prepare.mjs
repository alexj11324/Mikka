import { loadEnvironment } from '/home/user/Mikka/scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '/home/user/Mikka/scripts/test-accounts/pool.mjs'
const { Pool } = (await import('/home/user/Mikka/node_modules/pg/lib/index.js')).default
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
const pool = new TestAccountPool(db, await loadEnvironment())
await pool.prepare({ pairs: Number(process.argv[2] ?? 12) })
const s = await pool.inspect(); console.log(s.pairs.map(p => p.state).join(','))
await db.end()
