import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isBareRepositoryName, matchRepositoryName } from './repository-match'

const repo = (fullName: string) => ({ fullName })

test('a bare name has no owner and is not a URL', () => {
  for (const name of ['Mikka_test', 'mikka-test', 'MIKKA.TEST', 'Mikka test', ' Mikka_test ', 'repo.git']) assert.equal(isBareRepositoryName(name), true, name)
  for (const name of ['alexj11324/Mikka_test', 'https://github.com/alexj11324/Mikka_test', 'git@github.com:alexj11324/Mikka_test.git', 'ssh://git@github.com/a/b', '', '   ', '...', '-_', 'x'.repeat(101), 'Mikka测试']) assert.equal(isBareRepositoryName(name), false, name)
})

test('case and -, _, ., spaces are not told apart', () => {
  const repositories = [repo('alexj11324/Mikka_test'), repo('alexj11324/Mikka'), repo('alexj11324/other')]
  for (const name of ['Mikka_test', 'mikka-test', 'MIKKA.TEST', 'mikka test', 'mikkatest', 'Mikka_test.git']) {
    assert.deepEqual(matchRepositoryName(name, repositories), { kind: 'one', repository: repositories[0] }, name)
  }
  assert.deepEqual(matchRepositoryName('mikka', repositories), { kind: 'one', repository: repositories[1] })
  assert.deepEqual(matchRepositoryName('mikka-tests', repositories), { kind: 'none' })
  assert.deepEqual(matchRepositoryName('Mikka_test', []), { kind: 'none' })
})

test('only the repository part is matched, never the owner', () => {
  assert.deepEqual(matchRepositoryName('alexj11324', [repo('alexj11324/Mikka_test')]), { kind: 'none' })
})

test('a case-insensitive exact name wins over a loose one', () => {
  const exact = repo('alexj11324/mikka-test'), looseOne = repo('alexj11324/Mikka_Test')
  assert.deepEqual(matchRepositoryName('MIKKA-TEST', [looseOne, exact]), { kind: 'one', repository: exact })
  assert.deepEqual(matchRepositoryName('mikka.test', [looseOne, exact]), { kind: 'several', candidates: [looseOne, exact] })
})

test('the same name under several owners is several, listed in order', () => {
  const mine = repo('alexj11324/Mikka_test'), org = repo('mikka-org/mikka_test')
  assert.deepEqual(matchRepositoryName('Mikka_test', [mine, repo('x/y'), org]), { kind: 'several', candidates: [mine, org] })
})
