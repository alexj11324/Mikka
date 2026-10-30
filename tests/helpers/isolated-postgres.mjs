import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { isE2eTarget } from './e2e-target.mjs'

// Each schema-only migration fixture needs its own database-scoped extensions.
export async function isolatedPostgresURL(connectionString) {
  const target = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || !(['/mikka_improvement', '/factory193', '/mikka_monitor_195'].includes(target.pathname) || isE2eTarget(connectionString))
    || target.search || target.hash) throw new Error('Fixture requires a disposable test database')
  const admin = new Pool({ connectionString: target.toString(), max: 1 })
  const database = `mikka_fixture_${randomUUID().replaceAll('-', '')}`
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  } finally { await admin.end() }
  // Retain only this synthetic database for inspection until its service expires.
  target.pathname = `/${database}`
  return target.toString()
}
