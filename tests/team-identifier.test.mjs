import assert from 'node:assert/strict'
import test from 'node:test'
import { suggestTeamIdentifier } from '../lib/team-identifier.ts'

for (const [name, expected] of [
  ['eng', 'ENG'], ['Engineering', 'ENG'], ['Design team', 'DT'],
  ['Quality Assurance', 'QA'], ['  customer-success  ', 'CS'],
  ['Équipe', 'EQU'], ['123 engineering', 'ENG'], ['a', 'A0'],
  ['工程团队', 'TEAM'], ['123', 'TEAM'], ['🚀', 'TEAM'], ['', ''], ['   ', ''],
]) test(`根据团队名称生成合法标识：${JSON.stringify(name)}`, () => {
  const value = suggestTeamIdentifier(name)
  assert.equal(value, expected)
  if (value) assert.match(value, /^[A-Z][A-Z0-9]{1,11}$/)
})

test('自动标识忽略大小写并避开当前工作区已有标识', () => {
  assert.equal(suggestTeamIdentifier('eng', ['eng', 'ENG2', 'ENG4']), 'ENG3')
  assert.equal(suggestTeamIdentifier('工程团队', ['TEAM']), 'TEAM2')
})

test('名称及冲突后缀不会超出服务端标识长度限制', () => {
  const name = 'a b c d e f g h i j k l m n'
  const base = suggestTeamIdentifier(name)
  assert.equal(base, 'ABCDEFGHIJKL')
  const collision = suggestTeamIdentifier(name, [base])
  assert.equal(collision, 'ABCDEFGHIJK2')
  assert.match(collision, /^[A-Z][A-Z0-9]{1,11}$/)
})
