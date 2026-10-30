import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { settingsItemVisible } from '../lib/settings-sidebar-search.ts'

const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8')).Settings
const workspaceItem = { groupTitle: 'Workspace', groupLabel: zh.groups.workspace, itemTitle: 'General', label: zh.sections.general.title, section: 'general', routed: false }

test('zh-CN 下中文标题与英文名都能搜到工作区', () => {
  for (const query of [zh.sections.general.title, 'General', 'general', '  GENER ', zh.groups.workspace]) assert.equal(settingsItemVisible({ ...workspaceItem, query }), true, query)
  assert.equal(settingsItemVisible({ ...workspaceItem, query: 'zzz-no-match' }), false)
})

test('团队、成员仅在路由设置页显示，搜索不改变该规则', () => {
  for (const [section, itemTitle, label] of [['teams', 'Teams', zh.sections.teams.title], ['members', 'Members', zh.sections.members.title]]) {
    const item = { groupTitle: 'Workspace', groupLabel: zh.groups.workspace, itemTitle, label, section }
    for (const query of ['', label, itemTitle]) {
      assert.equal(settingsItemVisible({ ...item, query, routed: false }), false, `${section} hidden: ${query}`)
      assert.equal(settingsItemVisible({ ...item, query, routed: true }), true, `${section} routed: ${query}`)
    }
  }
  const workspace = { groupTitle: 'Workspace', groupLabel: zh.groups.workspace, itemTitle: 'General', label: zh.sections.general.title, section: 'general', query: '' }
  assert.equal(settingsItemVisible({ ...workspace, routed: false }), true)
})

test('模型订阅 finds subscriptions; 额度 and 可用模型 find their workspace sections instead', () => {
  const subscriptions = { groupTitle: 'Personal', groupLabel: 'x', itemTitle: 'Model subscriptions', label: zh.sections.models.title, keywords: zh.sections.models.keywords, section: 'models', routed: false }
  for (const query of ['ChatGPT', 'chatgpt', 'Claude', 'Codex', '订阅', '模型订阅']) assert.equal(settingsItemVisible({ ...subscriptions, query }), true, query)
  for (const query of ['额度', 'quota']) assert.equal(settingsItemVisible({ ...subscriptions, query }), false, query)
  const usage = { ...subscriptions, groupTitle: 'Workspace', itemTitle: 'Usage', label: zh.sections.usage.title, keywords: zh.sections.usage.keywords, section: 'usage' }
  for (const query of ['额度', 'quota']) assert.equal(settingsItemVisible({ ...usage, query }), true, query)
  const bots = { ...subscriptions, groupTitle: 'Workspace', itemTitle: 'Bots', label: zh.sections.bots.title, keywords: zh.sections.bots.keywords, section: 'bots' }
  assert.equal(settingsItemVisible({ ...bots, query: '可用模型' }), true)
  const other = { ...subscriptions, itemTitle: 'General', label: zh.sections.general.title, keywords: '', section: 'general' }
  for (const query of ['额度', 'quota', 'Claude']) assert.equal(settingsItemVisible({ ...other, query }), false, query)
})
