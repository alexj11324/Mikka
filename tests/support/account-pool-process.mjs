// A real OS process and independent PostgreSQL connection. IPC contains only
// pool metadata; account credentials and session state never cross this channel.
import { Pool } from 'pg'
import { loadEnvironment } from '../../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../../scripts/test-accounts/pool.mjs'

let database
let accounts
try {
  const environment = await loadEnvironment()
  database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 })
  accounts = new TestAccountPool(database, environment)
  process.send?.({ ready: true })
} catch (error) {
  process.send?.({ ready: false, error: { code: error.code ?? error.name } })
  await database?.end()
  process.exitCode = 1
  process.disconnect?.()
}

process.on('message', async message => {
  if (!accounts) return
  try {
    let result
    switch (message.operation) {
      case 'acquire': result = await accounts.acquire(message.input); break
      case 'renew': result = await accounts.renew(message.input.lease, message.input.options); break
      case 'release': result = await accounts.release(message.input.lease, message.input.options); break
      case 'inspect': result = await accounts.inspect(); break
      case 'close':
        await database.end()
        process.send?.({ id: message.id, ok: true })
        process.disconnect?.()
        return
      default: throw new Error('unsupportedOperation')
    }
    process.send?.({ id: message.id, ok: true, result })
  } catch (error) {
    process.send?.({ id: message.id, ok: false, error: { code: error.code ?? error.name } })
  }
})
