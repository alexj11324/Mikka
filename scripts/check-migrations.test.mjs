import test from 'node:test'
import assert from 'node:assert/strict'
import { checkMigrations, parseTimestamp, hash } from './check-migrations.mjs'

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
