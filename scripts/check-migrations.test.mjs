import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkMigrations, parseTimestamp, hash, slotCollisions, liveCollisions } from './check-migrations.mjs'

const legacy = { '0004_a.sql': hash('a'), '0004_b.sql': hash('b'), '0014_c.sql': hash('c') }
const base = [{ name: '0004_a.sql', content: 'a' }, { name: '0004_b.sql', content: 'b' }, { name: '0014_c.sql', content: 'c' }]
const main = ['0004_a.sql', '0004_b.sql', '0014_c.sql', '20261023010000_x.sql']
const mainBody = { name: '20261023010000_x.sql', content: 'SELECT 1;' }
const run = (extra, mainFiles = main) => checkMigrations([...base, mainBody, ...extra], mainFiles, legacy)

test('历史重号在白名单内通过', () => assert.deepEqual(run([]), []))
test('新的 NNNN_ 文件被拒绝', () => assert.equal(run([{ name: '0015_new.sql', content: '' }]).length, 1))
test('修改旧迁移被拒绝', () => assert.match(checkMigrations([{ name: '0004_a.sql', content: 'changed' }, base[1], base[2]], main, legacy)[0], /不能修改/))
test('删除旧迁移被拒绝', () => assert.match(checkMigrations(base.slice(1), main, legacy)[0], /不能删除/))
test('非法时间戳被拒绝', () => {
  assert.equal(parseTimestamp('20261332000000_x.sql'), null)
  assert.equal(parseTimestamp('20261023250000_x.sql'), null)
  assert.equal(parseTimestamp('20261023_x.sql'), null)
  assert.equal(parseTimestamp('20261023010000_Bad-Name.sql'), null)
  assert.equal(run([{ name: '20260230000000_x.sql', content: '' }]).length, 1)
})
test('未执行的新迁移早于 main 最新时间戳仍可合并', () => assert.deepEqual(run([{ name: '20261023005959_old.sql', content: 'SELECT 2;' }]), []))
test('晚于 main 最新迁移通过', () => assert.deepEqual(run([{ name: '20261023010001_new.sql', content: '' }]), []))
test('时间戳重复被拒绝', () => assert.match(run([{ name: '20261024000000_a.sql', content: '' }, { name: '20261024000000_b.sql', content: '' }]).join(), /相同/))
test('拿不到 main 时保留文件名和冻结旧迁移检查', () => assert.deepEqual(run([{ name: '20261023005959_old.sql', content: '' }], null), []))

// --all-refs: the main-only check cannot see a race that is still in flight, so a
// slot check has to ask what every ref claimed, not only what main already merged.
test('slotCollisions reports a timestamp two files claim and leaves a lone slot alone', () => {
  const names = [
    '20261110220000_thread_modes.sql',
    '20261110220000_tool_approval_decisions.sql',
    '20261110235900_agent_profile_skill_shares.sql',
    '0004_a.sql',
  ]
  assert.deepEqual(slotCollisions(names), [{ slot: '20261110220000', names: ['20261110220000_thread_modes.sql', '20261110220000_tool_approval_decisions.sql'] }])
})

test('slotCollisions counts one file once however many refs carry it', () => {
  const one = ['20261110230000_api_tokens.sql', '20261110230000_api_tokens.sql']
  assert.deepEqual(slotCollisions(one), [])
})

test('slotCollisions ignores an illegal timestamp instead of inventing a slot', () => {
  assert.deepEqual(slotCollisions(['20261110240000_a.sql', '20261110240000_b.sql']), [])
})

test('slotCollisions sorts a slot\'s names so the report is stable', () => {
  const names = ['20261110230000_zulu.sql', '20261110230000_alpha.sql', '20261110230000_mike.sql']
  assert.deepEqual(slotCollisions(names)[0].names, ['20261110230000_alpha.sql', '20261110230000_mike.sql', '20261110230000_zulu.sql'])
})

// --enforce judges a live race, not a settled one: a slot where one file already
// merged must not red every unrelated pull request.
test('liveCollisions keeps only slots no file has reached main from', () => {
  const collisions = [
    { slot: '20261110220000', names: ['20261110220000_thread_modes.sql', '20261110220000_tool_approval_decisions.sql'] },
    { slot: '20261030074000', names: ['20261030074000_factory_publication_failed.sql', '20261030074000_workspace_settings_bot_defaults_version.sql'] },
  ]
  const main = ['20261030074000_factory_publication_failed.sql']
  assert.deepEqual(liveCollisions(collisions, main).map((c) => c.slot), ['20261110220000'])
})

test('a slot with every name on main is settled, not live', () => {
  const collisions = [{ slot: '20261023044800', names: ['20261023044800_issue_search_pg_trgm.sql', '20261023044800_issue_search_trgm.sql'] }]
  assert.deepEqual(liveCollisions(collisions, ['20261023044800_issue_search_pg_trgm.sql', '20261023044800_issue_search_trgm.sql']), [])
})

test('without main every collision counts as live rather than silently passing', () => {
  const collisions = [{ slot: '20261110220000', names: ['20261110220000_a.sql', '20261110220000_b.sql'] }]
  assert.equal(liveCollisions(collisions, null).length, 1)
})

test('main timestamp migrations keep their names and exact SQL bytes', () => {
  const snapshots = [...base, mainBody]
  assert.deepEqual(checkMigrations(snapshots, snapshots, legacy), [])
  assert.match(checkMigrations([...base, { ...mainBody, content: mainBody.content + '\n' }], snapshots, legacy).join(), /main.*不能修改/)
  assert.match(checkMigrations(base, snapshots, legacy).join(), /main.*不能删除或改名/)
  assert.match(checkMigrations([...base, { ...mainBody, name: '20261023010001_renamed.sql' }], snapshots, legacy).join(), /main.*不能删除或改名/)
})

test('the actual CLI accepts a stale branch with an older pending file and freezes inherited history', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-check-'))
  const scripts = join(root, 'scripts'), directory = join(root, 'drizzle')
  mkdirSync(scripts); mkdirSync(directory)
  writeFileSync(join(scripts, 'check-migrations.mjs'), readFileSync(new URL('./check-migrations.mjs', import.meta.url)))
  const actual = new URL('../drizzle/', import.meta.url)
  const names = readdirSync(actual).filter(name => name.endsWith('.sql'))
  for (const name of names) writeFileSync(join(directory, name), readFileSync(new URL(name, actual)))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'pipe' })
  git('init', '-qb', 'main'); git('add', '.'); git('commit', '-qm', 'inherited history')
  git('checkout', '-qb', 'feature')
  writeFileSync(join(directory, '20261112000000_branch_older.sql'), 'SELECT 1;')
  git('add', '.'); git('commit', '-qm', 'independent pending migration')
  git('checkout', '-q', 'main')
  writeFileSync(join(directory, '20300101000000_later_main.sql'), 'SELECT 2;')
  git('add', '.'); git('commit', '-qm', 'unrelated later main migration')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('checkout', '-q', 'feature')
  const check = () => spawnSync(process.execPath, [join(scripts, 'check-migrations.mjs')], { cwd: root, encoding: 'utf8' })
  const accepted = check()
  assert.equal(accepted.status, 0, accepted.stderr)
  const inherited = names.find(name => parseTimestamp(name))
  writeFileSync(join(directory, inherited), readFileSync(new URL(inherited, actual), 'utf8') + '\n-- changed')
  assert.match(check().stderr, /main.*不能修改/)
  unlinkSync(join(directory, inherited))
  assert.match(check().stderr, /main.*不能删除或改名/)
})
