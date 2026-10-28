import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs'
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
    writeFileSync(join(dir, 'migration-steps.mjs'), readFileSync(new URL('./migration-steps.mjs', import.meta.url), 'utf8'))
    writeFileSync(join(dir, 'migration-targets.mjs'), readFileSync(new URL('./migration-targets.mjs', import.meta.url)))
    writeFileSync(join(dir, 'preview-database-url.mjs'), readFileSync(new URL('./preview-database-url.mjs', import.meta.url)))
    writeFileSync(join(dir, 'pg.mjs'), 'export class Pool { constructor() { throw new Error("DATABASE_ACCESS") } }')
    writeFileSync(join(dir, 'order.mjs'), 'export const orderMigrations = x => x; export const alreadyApplied = (name, applied) => applied.has(name)')
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
        env: { ...process.env, DATABASE_URL: 'postgres://user:fixture@preview-fixture:5432/testdb', MIGRATE: mode, VERCEL_ENV: environment }, encoding: 'utf8',
      })
      assert.notEqual(result.status, 0)
      assert.doesNotMatch(result.stdout, /migrate: skipped/)
      assert.match(result.stderr, /ENOENT/)
    }
    const missing = spawnSync(process.execPath, [join(dir, 'migrate.mjs')], {
      env: { ...process.env, MIGRATE: '1', VERCEL_ENV: 'preview', DATABASE_URL: '', MIKKA_DATABASE_URL: 'postgres://production-fixture' }, encoding: 'utf8',
    })
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /PREVIEW_DATABASE_URL_REQUIRED/)
    assert.doesNotMatch(missing.stderr, /DATABASE_ACCESS|ENOENT/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('explicit Preview migration never connects to the global application target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-preview-target-'))
  try {
    const scripts = join(dir, 'scripts'), migrations = join(dir, 'drizzle')
    mkdirSync(scripts); mkdirSync(migrations)
    const source = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8')
      .replace("'pg'", "'./pg.mjs'")
      .replace("from './migration-order.mjs'", "from './order.mjs'")
    writeFileSync(join(scripts, 'migrate.mjs'), source)
    writeFileSync(join(scripts, 'migration-steps.mjs'), readFileSync(new URL('./migration-steps.mjs', import.meta.url)))
    writeFileSync(join(scripts, 'migration-targets.mjs'), readFileSync(new URL('./migration-targets.mjs', import.meta.url)))
    writeFileSync(join(scripts, 'preview-database-url.mjs'), readFileSync(new URL('./preview-database-url.mjs', import.meta.url)))
    writeFileSync(join(scripts, 'order.mjs'), 'export const orderMigrations = x => x; export const alreadyApplied = () => false')
    writeFileSync(join(scripts, 'pg.mjs'), `export class Pool {
      constructor({connectionString}) { if (connectionString !== 'postgres://user:fixture@preview-fixture:5432/testdb') throw Error('WRONG_DATABASE'); }
      async query() { return {rows: []} }
      async connect() { return {query: async () => ({}), release() {}} }
      async end() {}
    }`)
    writeFileSync(join(migrations, '0001_application.sql'), '-- target: MIKKA_DATABASE_URL\nSELECT 1;')
    writeFileSync(join(migrations, '0002_workspace.sql'), '-- target: DATABASE_URL\nSELECT 1;')
    const result = spawnSync(process.execPath, [join(scripts, 'migrate.mjs')], {
      env: { ...process.env, MIGRATE: '1', VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://user:fixture@preview-fixture/testdb', MIKKA_DATABASE_URL: 'postgres://production-fixture' }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /0001_application.sql/)
    assert.match(result.stdout, /0002_workspace.sql/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('default production build never dispatches migration even with MIGRATE=1', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts.migrate, 'node scripts/migrate.mjs')
  assert.equal(manifest.scripts.prebuild, undefined)
  assert.equal(manifest.scripts.postbuild, undefined)
  const dir = mkdtempSync(join(tmpdir(), 'code-only-build-'))
  try {
    const trace = join(dir, 'trace')
    for (const name of ['node', 'pnpm', 'next']) {
      const executable = join(dir, name)
      writeFileSync(executable, `#!/bin/sh
case "${name} $*" in
  "node scripts/build-subscription-worker.mjs"|"pnpm generate:agent-ui"|"pnpm lint"|"next build") printf '%s\n' "${name} $*" >> "$BUILD_TEST_TRACE" ;;
  *) echo UNEXPECTED_BUILD_SIDE_EFFECT >&2; exit 91 ;;
esac
`)
      chmodSync(executable, 0o700)
    }
    const result = spawnSync('/bin/sh', ['-c', manifest.scripts.build], {
      cwd: dir, env: { PATH: dir, VERCEL_ENV: 'production', MIGRATE: '1', BUILD_TEST_TRACE: trace }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['node scripts/build-subscription-worker.mjs', 'pnpm generate:agent-ui', 'pnpm lint', 'next build'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('all files preflight before a database connection, even if an earlier file is valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-preflight-'))
  try {
    // A scripts sibling directory preserves the real entrypoint's ../drizzle resolution.
    const scripts = join(dir, 'scripts')
    const drizzle = join(dir, 'drizzle')
    // Imported lazily to keep the original fixtures above unchanged.
    const { mkdirSync } = process.getBuiltinModule('node:fs')
    mkdirSync(scripts); mkdirSync(drizzle)
    const source = readFileSync(new URL('./migrate.mjs', import.meta.url), 'utf8').replace("'pg'", "'./pg.mjs'")
    writeFileSync(join(scripts, 'migrate.mjs'), source)
    writeFileSync(join(scripts, 'migration-order.mjs'), 'export const orderMigrations = x => x.sort(); export const alreadyApplied = (name, applied) => applied.has(name)')
    writeFileSync(join(scripts, 'migration-steps.mjs'), readFileSync(new URL('./migration-steps.mjs', import.meta.url), 'utf8'))
    writeFileSync(join(scripts, 'migration-targets.mjs'), readFileSync(new URL('./migration-targets.mjs', import.meta.url)))
    writeFileSync(join(scripts, 'preview-database-url.mjs'), readFileSync(new URL('./preview-database-url.mjs', import.meta.url)))
    writeFileSync(join(scripts, 'pg.mjs'), 'export class Pool { constructor() { throw new Error("DATABASE_ACCESS") } }')
    writeFileSync(join(drizzle, '20261028000001_valid.sql'), 'select 1;')
    writeFileSync(join(drizzle, '20261028000002_invalid.sql'), '-- migrate: no-transaction\nselect 1; select 2;')
    const result = spawnSync(process.execPath, [join(scripts, 'migrate.mjs')], {
      env: { ...process.env, MIGRATE: '1', VERCEL_ENV: '' }, encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /20261028000002_invalid.sql.*exactly one statement/)
    assert.doesNotMatch(result.stderr, /DATABASE_ACCESS/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
