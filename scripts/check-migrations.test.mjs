import test from 'node:test'
import assert from 'node:assert/strict'
import { checkMigrations, parseTimestamp, hash, slotCollisions, liveCollisions } from './check-migrations.mjs'

const legacy = { '0004_a.sql': hash('a'), '0004_b.sql': hash('b'), '0014_c.sql': hash('c') }
const base = [{ name: '0004_a.sql', content: 'a' }, { name: '0004_b.sql', content: 'b' }, { name: '0014_c.sql', content: 'c' }]
const main = ['0004_a.sql', '0004_b.sql', '0014_c.sql', '20261023010000_x.sql']
const run = (extra, mainFiles = main) => checkMigrations([...base, ...extra], mainFiles, legacy)

test('历史重号在白名单内通过', () => assert.deepEqual(run([{ name: '20261023010000_x.sql', content: '' }]), []))
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
test('不晚于 main 最新迁移被拒绝', () => assert.match(run([{ name: '20261023005959_old.sql', content: '' }]).join(), /晚于 main/))
test('晚于 main 最新迁移通过', () => assert.deepEqual(run([{ name: '20261023010001_new.sql', content: '' }]), []))
test('时间戳重复被拒绝', () => assert.match(run([{ name: '20261024000000_a.sql', content: '' }, { name: '20261024000000_b.sql', content: '' }]).join(), /相同/))
test('拿不到 main 时只跳过顺序检查', () => assert.deepEqual(run([{ name: '20261023005959_old.sql', content: '' }], null), []))

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
