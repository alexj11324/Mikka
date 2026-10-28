#!/usr/bin/env node
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { assertDeploymentIdentity, loadEnvironment } from './environment.mjs'
import { TestAccountPool, TestAccountError } from './pool.mjs'
import { auditEvidence } from './session.mjs'

const operations = new Set(['prepare', 'acquire', 'renew', 'release', 'inspect', 'cleanup-plan', 'audit-evidence'])
const fail = code => { throw new TestAccountError(code) }
function parse(args) {
  const [operation, ...rest] = args
  if (!operations.has(operation)) fail('UNKNOWN_OPERATION')
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    if (key === '--dry-run') { options.dryRun = true; continue }
    if (!['--run', '--worker', '--request', '--lease-file', '--pairs', '--ttl-ms', '--outcome', '--evidence'].includes(key) || options[key] !== undefined || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS')
    options[key] = rest[++i]
  }
  return { operation, options }
}
async function leaseFile(path, value) {
  if (!path) fail('LEASE_FILE_REQUIRED')
  const handle = await open(resolve(path), constants.O_NOFOLLOW | (value ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY), 0o600)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536 || (process.getuid && stat.uid !== process.getuid())) fail('LEASE_FILE_UNSAFE')
    if (value) { await handle.truncate(0); await handle.writeFile(`${JSON.stringify(value)}\n`); return }
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}
const publicLease = lease => ({ leaseId: lease.id, environmentId: lease.environmentId, runId: lease.runId, workerId: lease.workerId, generation: lease.generation, expiresAt: lease.expiresAt, state: lease.state, accounts: lease.accounts.map(account => ({ role: account.role, slotId: account.slotId, userId: account.userId, namespace: account.namespace })) })

let database
try {
  const { operation, options } = parse(process.argv.slice(2))
  const environment = await loadEnvironment()
  database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
  const pool = new TestAccountPool(database, environment)
  let result
  if (options.dryRun || operation === 'inspect') {
    result = { ...await pool.inspect(), dryRun: true }
  } else if (operation === 'cleanup-plan') {
    result = await pool.cleanupPlan({ runId: options['--run'] })
  } else if (operation === 'audit-evidence') {
    if (!options['--evidence']) fail('EVIDENCE_PATH_REQUIRED')
    result = await auditEvidence([options['--evidence']], { environment })
  } else if (operation === 'prepare') {
    // Test metadata only; no users, login or implicit registration here.
    result = await pool.prepare({ pairs: Number(options['--pairs'] ?? 2) })
  } else if (operation === 'acquire') {
    if (!options['--lease-file']) fail('LEASE_FILE_REQUIRED')
    await assertDeploymentIdentity(environment)
    const lease = await pool.acquire({ runId: options['--run'], workerId: options['--worker'], requestId: options['--request'], ttlMs: Number(options['--ttl-ms'] ?? 90000) })
    await leaseFile(options['--lease-file'], lease)
    result = publicLease(lease)
  } else {
    const lease = await leaseFile(options['--lease-file'])
    const next = operation === 'renew' ? await pool.renew(lease, { ttlMs: Number(options['--ttl-ms'] ?? lease.ttlMs) }) : await pool.release(lease, { outcome: options['--outcome'] ?? 'clean' })
    await leaseFile(options['--lease-file'], next)
    result = publicLease(next)
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'TEST_ACCOUNT_COMMAND_FAILED'
  console.error(JSON.stringify({ status: 'blocked', code }))
  process.exitCode = 1
} finally { await database?.end() }
