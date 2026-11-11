import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { newMigration } from './new-migration.mjs'
import { parseTimestamp } from './check-migrations.mjs'

const execute = promisify(execFile)
const moduleUrl = new URL('./new-migration.mjs', import.meta.url).href
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'migration-generator-'))
  execFileSync('git', ['init', '-q', root])
  mkdirSync(join(root, 'drizzle'))
  return root
}

test('the generator uses the actual UTC clock, and refuses unsafe names', () => {
  const root = fixture(), before = Date.now()
  const file = newMigration('add_project_notes', { root })
  const id = parseTimestamp(file.split('/').at(-1))
  const date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:${id.slice(12, 14)}Z`
  assert.ok(Date.parse(date) >= Math.floor(before / 1000) * 1000 && Date.parse(date) <= Date.now())
  assert.match(readFileSync(file, 'utf8'), /^-- target: MIKKA_DATABASE_URL/)
  for (const name of ['../escape', 'Uppercase', 'with-dash', '', '_leading']) assert.throws(() => newMigration(name, { root }), /snake_case/)
})

test('a known future migration and a same-second collision advance through valid UTC rollover', () => {
  const root = fixture()
  writeFileSync(join(root, 'drizzle', '20261231235959_existing.sql'), 'SELECT 1;')
  const now = () => new Date('2026-11-11T12:00:00Z')
  assert.match(newMigration('first', { root, now }), /20270101000000_first\.sql$/)
  assert.match(newMigration('second', { root, now }), /20270101000001_second\.sql$/)
})

test('concurrent processes in separate worktrees reserve one unique ID per migration', async () => {
  const root = fixture()
  writeFileSync(join(root, 'drizzle', '20261112030000_existing.sql'), 'SELECT 1;')
  execFileSync('git', ['add', 'drizzle'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  const other = join(mkdtempSync(join(tmpdir(), 'migration-worktree-')), 'other')
  execFileSync('git', ['worktree', 'add', '-qb', 'parallel', other], { cwd: root })
  const generated = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const directory = index % 2 ? other : root
    const code = `import {newMigration} from ${JSON.stringify(moduleUrl)}; console.log(newMigration('parallel_${index}',{root:${JSON.stringify(directory)},now:()=>new Date('2026-11-11T12:00:00Z')}))`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', code])
    return stdout.trim()
  }))
  const ids = generated.map(file => parseTimestamp(file.split('/').at(-1)))
  assert.equal(new Set(ids).size, 12)
  assert.deepEqual([...ids].sort(), Array.from({ length: 12 }, (_, index) => `202611120300${String(index + 1).padStart(2, '0')}`))
  assert.equal([root, other].flatMap(directory => readdirSync(join(directory, 'drizzle'))).filter(name => name.includes('parallel_')).length, 12)
  for (const file of generated) assert.match(readFileSync(file, 'utf8'), /Add the migration SQL/)
})
