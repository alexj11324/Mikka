import assert from 'node:assert/strict'
import test from 'node:test'
import { localeAliasPath } from './locale-alias'

test('redirects zh aliases to zh-CN and leaves real locales alone', () => {
  assert.equal(localeAliasPath('/zh'), '/zh-CN')
  assert.equal(localeAliasPath('/zh/settings'), '/zh-CN/settings')
  assert.equal(localeAliasPath('/ZH'), '/zh-CN')
  assert.equal(localeAliasPath('/zh-cn'), '/zh-CN')
  assert.equal(localeAliasPath('/zh-cn/en'), '/zh-CN/en')
  assert.equal(localeAliasPath('/zh-CN'), null)
  assert.equal(localeAliasPath('/zh-CN/settings'), null)
  assert.equal(localeAliasPath('/en'), null)
  assert.equal(localeAliasPath('/'), null)
  assert.equal(localeAliasPath('/workspaces'), null)
})
