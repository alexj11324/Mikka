import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import { afterCommit } from './commit-effects'

const url = process.env.E2E_DATABASE_URL
if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true') assert.ok(url, 'CI requires real isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('deferred post-commit reads retain their database and device authority after releasing the writer', { skip: !url, timeout: 120_000 }, async t => {
  const connectionString = await isolatedPostgresURL(url!)
  const admin = new Pool({ connectionString })
  const { pool, createRequestDatabaseScope, withDatabaseClient, withoutDatabaseClient } = await import('./request-scope')
  const { withDeviceDatabaseAuthority, isDeviceAuthorityRevoked } = await import('./device-scope')
  await admin.query(`CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text,"revokedAt" timestamptz,"expiresAt" timestamptz)`)
  const expectedDatabase = new URL(connectionString).pathname.slice(1)
  assert.notEqual(expectedDatabase, new URL(url!).pathname.slice(1))
  const owner = 'live-scope-fixture'
  try {
    for (const mode of ['live', 'revoked', 'closed'] as const) await t.test(mode, async () => {
      const tokenId = randomUUID()
      await admin.query('INSERT INTO device_tokens VALUES ($1,$2,NULL,NULL)', [tokenId, owner])
      const scope = createRequestDatabaseScope(connectionString)
      let continueRead!: () => void
      const gate = new Promise<void>(resolve => { continueRead = resolve })
      let result: Promise<{ database: string }> = Promise.resolve({ database: '' })
      try {
        await scope.run(() => withDeviceDatabaseAuthority({ tokenId, userId: owner }, async () => {
          const tx = await pool.connect()
          try {
            await tx.query('BEGIN')
            await withDatabaseClient(tx, async () => {
              afterCommit(tx, 'deferred-read', () => {
                // Like Next after, the asynchronous work captures the committing request's ALS context.
                result = (async () => {
                  await gate
                  return withoutDatabaseClient(async () => (await pool.query<{ database: string }>('SELECT current_database() AS database')).rows[0])
                })()
              })
              await tx.query('COMMIT')
            })
          } finally { tx.release() }
        }))
        if (mode === 'revoked') await admin.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
        if (mode === 'closed') await scope.close()
        const assertion = mode === 'live'
          ? result.then(value => { assert.equal(value.database, expectedDatabase) })
          : assert.rejects(result, error => mode === 'revoked' ? isDeviceAuthorityRevoked(error) : error instanceof Error && /pool after calling end/i.test(error.message))
        continueRead()
        await assertion
      } finally { continueRead(); await scope.close() }
    })
  } finally { await admin.end() }
})
