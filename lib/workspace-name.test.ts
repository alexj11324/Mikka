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
  assert.equal(defaultWorkspaceName('zh-CN', '阿达'), fill(zh.Members.defaultWorkspaceName, '阿达'))
  assert.equal(defaultWorkspaceName('en', '  '), en.Members.myWorkspace)
  assert.equal(defaultWorkspaceName('zh-CN', null), zh.Members.myWorkspace)
})

test('renames only an auto-generated name from the other locale', () => {
  const chinese = 'Ada 的工作区'
  const english = fill(en.Members.defaultWorkspaceName, 'Ada')
  assert.equal(renameGeneratedWorkspace(chinese, 'en', 'Ada'), english)
  assert.equal(renameGeneratedWorkspace(english, 'zh-CN', 'Ada'), chinese)
  assert.equal(renameGeneratedWorkspace(english, 'en', 'Ada'), null)
  assert.equal(renameGeneratedWorkspace('Custom workspace', 'en', 'Ada'), null)
  assert.equal(renameGeneratedWorkspace(zh.Members.myWorkspace, 'en', ''), en.Members.myWorkspace)
})

test('puts a space between a Latin name and Chinese text, not after a Chinese name', () => {
  assert.equal(defaultWorkspaceName('zh-CN', 'Test owner'), 'Test owner 的工作区')
  assert.equal(defaultWorkspaceName('zh-CN', 'Ada2'), 'Ada2 的工作区')
  assert.equal(defaultWorkspaceName('zh-CN', '张三'), '张三的工作区')
  assert.equal(defaultWorkspaceName('en', 'Ada'), fill(en.Members.defaultWorkspaceName, 'Ada'))
})

test('a name generated before the space still renames with the locale', () => {
  assert.equal(renameGeneratedWorkspace('Ada的工作区', 'en', 'Ada'), fill(en.Members.defaultWorkspaceName, 'Ada'))
  assert.equal(renameGeneratedWorkspace('Ada的工作区', 'zh-CN', 'Ada'), 'Ada 的工作区')
})
