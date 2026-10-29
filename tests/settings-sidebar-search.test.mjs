import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { settingsItemVisible } from '../lib/settings-sidebar-search.ts'

const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8')).Settings
const workspaceItem = { groupTitle: 'Administration', groupLabel: zh.groups.administration, itemTitle: 'Workspace', label: zh.sections.workspace.title, section: 'workspace', routed: false }

test('zh-CN 下中文标题与英文名都能搜到工作区', () => {
  for (const query of [zh.sections.workspace.title, 'Workspace', 'workspace', '  WORK ', zh.groups.administration]) assert.equal(settingsItemVisible({ ...workspaceItem, query }), true, query)
  assert.equal(settingsItemVisible({ ...workspaceItem, query: 'zzz-no-match' }), false)
})

test('团队、成员仅在路由设置页显示，搜索不改变该规则', () => {
  for (const [section, itemTitle, label] of [['teams', 'Teams', zh.sections.teams.title], ['members', 'Members', zh.sections.members.title]]) {
    const item = { groupTitle: 'Administration', groupLabel: zh.groups.administration, itemTitle, label, section }
    for (const query of ['', label, itemTitle]) {
      assert.equal(settingsItemVisible({ ...item, query, routed: false }), false, `${section} hidden: ${query}`)
      assert.equal(settingsItemVisible({ ...item, query, routed: true }), true, `${section} routed: ${query}`)
    }
  }
  const workspace = { groupTitle: 'Administration', groupLabel: zh.groups.administration, itemTitle: 'Workspace', label: zh.sections.workspace.title, section: 'workspace', query: '' }
  assert.equal(settingsItemVisible({ ...workspace, routed: false }), true)
})

test('模型订阅在集成页：额度、quota、ChatGPT、Claude、Codex、订阅都能搜到', () => {
  const integrations = { groupTitle: 'Workspace', groupLabel: 'x', itemTitle: 'Integrations', label: zh.sections.integrations.title, keywords: zh.sections.integrations.keywords, section: 'integrations', routed: false }
  for (const query of ['额度', 'quota', 'ChatGPT', 'chatgpt', 'Claude', 'Codex', '订阅', '模型订阅']) assert.equal(settingsItemVisible({ ...integrations, query }), true, query)
  const other = { ...integrations, itemTitle: 'Workspace', label: zh.sections.workspace.title, keywords: '', section: 'workspace' }
  for (const query of ['额度', 'quota', 'Claude']) assert.equal(settingsItemVisible({ ...other, query }), false, query)
})
