import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')).FactoryAcceptance
const lookup = (key: string, args?: Record<string, string>) => {
  const value = key.split('.').reduce((node, part) => node?.[part], zh)
  assert.equal(typeof value, 'string', `missing FactoryAcceptance.${key}`)
  return (value as string).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
}
let swr: { data?: unknown; error?: unknown; isLoading: boolean; mutate: () => void }
mock.module('swr', { defaultExport: () => swr })
mock.module('next-intl', { namedExports: { useTranslations: () => lookup, useFormatter: () => ({ dateTime: () => '' }) } })
mock.module(new URL('./issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })

let FactoryAcceptance: typeof import('./factory-acceptance')['FactoryAcceptance']
let ApprovalBar: typeof import('./factory-approval-bar')['ApprovalBar']
before(async () => {
  ({ FactoryAcceptance } = await import('./factory-acceptance'))
  ;({ ApprovalBar } = await import('./factory-approval-bar'))
})
beforeEach(() => { swr = { isLoading: false, mutate: () => {} } })
const list = () => renderToStaticMarkup(<FactoryAcceptance issueId="issue-1" />)
const task = (patch: Record<string, unknown> = {}) => ({ id: 't1', issueId: 'issue-1', stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId: 'c1', candidateRunId: null, isSkillCandidate: false, ...patch })

test('loading reserves the row height with a skeleton', () => {
  swr.isLoading = true
  const html = list()
  assert.match(html, /data-slot="skeleton"/)
  assert.match(html, /h-16/)
  assert.match(html, /aria-busy="true"/)
})

test('a failed list shows the default alert with retry', () => {
  let retried = 0
  swr = { error: new Error('down'), isLoading: false, mutate: () => { retried++ } }
  const html = list()
  assert.match(html, /data-slot="alert"/)
  assert.doesNotMatch(html, /text-destructive/)
  assert.match(html, />无法加载验收</)
  assert.match(html, />重试</)
  assert.equal(retried, 0)
})

test('an empty list renders nothing', () => {
  swr.data = { tasks: [] }
  assert.equal(list(), '')
})

test('skill rows read 待启用 and ordinary rows keep 待你确认', () => {
  swr.data = { tasks: [task({ isSkillCandidate: true })] }
  assert.match(list(), />待启用</)
  swr.data = { tasks: [task()] }
  assert.match(list(), />待你确认</)
})

test('approval bar uses component defaults and the Figma copy for each state', () => {
  const bar = (state: Parameters<typeof ApprovalBar>[0]['state'], isSkill = false) =>
    renderToStaticMarkup(<ApprovalBar state={state} isSkill={isSkill} details={['Preview', 'abcdef1']} />)
  for (const state of ['pending', 'approved', 'publishing', 'checking', 'failed', 'live', 'revoked', 'expired', 'invalidated'] as const) {
    const html = bar(state)
    assert.match(html, /data-slot="item"/)
    assert.doesNotMatch(html, /bg-control|rounded-\[14px\]|line-through|bg-blue|bg-destructive/)
  }
  assert.match(bar('pending', true), />待启用<.*>启用</)
  assert.match(bar('live', true), />已启用</)
  assert.match(bar('failed'), />发布失败<.*>撤销批准<.*>核对发布</)
  assert.match(bar('invalidated'), />已失效</)
  assert.doesNotMatch(bar('invalidated'), /<button/)
  assert.match(bar('checking'), />发布待核对</)
})
