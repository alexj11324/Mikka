import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('explicit MIGRATE=0 exits before filesystem or database work in production', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-mode-'))
  try {
    // Real entrypoint in an isolated directory: absent drizzle and an instrumented
    // pg module make any file scan or Pool construction fail this regression.
    const source = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
      .replace("'pg'", "'./pg.mjs'")
      .replace("from './migration-order.mjs'", "from './order.mjs'")
    writeFileSync(join(dir, 'migrate.mjs'), source)
    writeFileSync(join(dir, 'pg.mjs'), 'export class Pool { constructor() { throw new Error("DATABASE_ACCESS") } }')
    writeFileSync(join(dir, 'order.mjs'), 'export const orderMigrations = x => x')
    for (const environment of ['production', 'preview']) {
      const result = spawnSync(process.execPath, [join(dir, 'migrate.mjs')], {
        env: { ...process.env, MIGRATE: '0', VERCEL_ENV: environment }, encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /explicit MIGRATE=0/)
    }
    // Default production and explicit opt-in must not silently skip migration.
    for (const [environment, mode] of [['production', ''], ['preview', '1']]) {
      const result = spawnSync(process.execPath, [join(dir, 'migrate.mjs')], {
        env: { ...process.env, MIGRATE: mode, VERCEL_ENV: environment }, encoding: 'utf8',
      })
      assert.notEqual(result.status, 0)
      assert.doesNotMatch(result.stdout, /migrate: skipped/)
      assert.match(result.stderr, /ENOENT/)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
