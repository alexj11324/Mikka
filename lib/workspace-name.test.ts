import assert from 'node:assert/strict'
import test from 'node:test'
import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'
import { defaultWorkspaceName, renameGeneratedWorkspace } from './workspace-name'

function fill(template: string, name: string) {
  return template.replaceAll('{name}', name)
}

test('builds a locale-specific default workspace name', () => {
  assert.equal(defaultWorkspaceName('en', 'Ada'), fill(en.Members.defaultWorkspaceName, 'Ada'))
  assert.equal(defaultWorkspaceName('zh-CN', 'Ada'), fill(zh.Members.defaultWorkspaceName, 'Ada'))
  assert.equal(defaultWorkspaceName('en', '  '), en.Members.myWorkspace)
  assert.equal(defaultWorkspaceName('zh-CN', null), zh.Members.myWorkspace)
})

test('renames only an auto-generated name from the other locale', () => {
  const chinese = fill(zh.Members.defaultWorkspaceName, 'Ada')
  const english = fill(en.Members.defaultWorkspaceName, 'Ada')
  assert.equal(renameGeneratedWorkspace(chinese, 'en', 'Ada'), english)
  assert.equal(renameGeneratedWorkspace(english, 'zh-CN', 'Ada'), chinese)
  assert.equal(renameGeneratedWorkspace(english, 'en', 'Ada'), null)
  assert.equal(renameGeneratedWorkspace('Custom workspace', 'en', 'Ada'), null)
  assert.equal(renameGeneratedWorkspace(zh.Members.myWorkspace, 'en', ''), en.Members.myWorkspace)
})
