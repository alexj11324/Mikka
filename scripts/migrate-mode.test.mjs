import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
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
    for (const name of ['historical-migrations.mjs', 'search-migrations.mjs', 'migration-session.mjs']) {
      writeFileSync(join(dir, name), readFileSync(new URL(name, import.meta.url)))
    }
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
  } finally { console.log('Retained pure migration fixture:', dir) }
})


test('default production build never dispatches migration even with MIGRATE=1', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts.migrate, 'node scripts/migrate.mjs')
  assert.equal(manifest.scripts.prebuild, undefined)
  assert.equal(manifest.scripts.postbuild, undefined)
  const dir = mkdtempSync(join(tmpdir(), 'code-only-build-'))
  try {
    const trace = join(dir, 'trace')
    for (const name of ['pnpm', 'next', 'node']) {
      const executable = join(dir, name)
      writeFileSync(executable, `#!/bin/sh
case "${name} $*" in
  "pnpm build:byos-workers"|"pnpm generate:agent-ui"|"pnpm lint"|"next build"|"node scripts/verify-subscription-worker-artifacts.mjs") printf '%s\n' "${name} $*" >> "$BUILD_TEST_TRACE" ;;
  *) echo UNEXPECTED_BUILD_SIDE_EFFECT >&2; exit 91 ;;
esac
`)
      chmodSync(executable, 0o700)
    }
    const result = spawnSync('/bin/sh', ['-c', manifest.scripts.build], {
      cwd: dir, env: { PATH: dir, VERCEL_ENV: 'production', MIGRATE: '1', BUILD_TEST_TRACE: trace }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['pnpm build:byos-workers', 'pnpm generate:agent-ui', 'pnpm lint', 'next build', 'node scripts/verify-subscription-worker-artifacts.mjs'])
  } finally { console.log('Retained code-only build fixture:', dir) }
})
