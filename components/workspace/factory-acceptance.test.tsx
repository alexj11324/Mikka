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
let ledger: unknown
mock.module('swr', { defaultExport: (key: string) => String(key).includes('view=ledger') ? { data: ledger, mutate: () => {} } : swr })
mock.module('next-intl', { namedExports: { useTranslations: () => lookup, useFormatter: () => ({ dateTime: () => '' }) } })
mock.module(new URL('./issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })

let FactoryAcceptance: typeof import('./factory-acceptance')['FactoryAcceptance']
let FactoryListError: typeof import('./factory-acceptance')['FactoryListError']
let ApprovalBar: typeof import('./factory-approval-bar')['ApprovalBar']
before(async () => {
  ({ FactoryAcceptance, FactoryListError } = await import('./factory-acceptance'))
  ;({ ApprovalBar } = await import('./factory-approval-bar'))
})
beforeEach(() => { swr = { isLoading: false, mutate: () => {} }; ledger = { approvals: [], publications: [] } })
const list = () => renderToStaticMarkup(<FactoryAcceptance issueId="issue-1" />)
const task = (patch: Record<string, unknown> = {}) => ({ id: 't1', issueId: 'issue-1', stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId: 'c1', candidateRunId: null, isSkillCandidate: false, ...patch })

test('loading reserves the row height with a skeleton', () => {
  swr.isLoading = true
  const html = list()
  assert.match(html, /data-slot="skeleton"/)
  assert.match(html, /h-16[^"]*rounded-xl"><div data-slot="skeleton" class="[^"]*size-full/)
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
  assert.match(html, /min-h-16/)
})

test('retry is disabled with a spinner while refetching', () => {
  const idle = renderToStaticMarkup(<FactoryListError retrying={false} onRetry={() => {}} />)
  assert.doesNotMatch(idle, /disabled=""|role="status"|animate-spin/)
  const busy = renderToStaticMarkup(<FactoryListError retrying onRetry={() => {}} />)
  assert.match(busy, /disabled=""/)
  assert.match(busy, /aria-busy="true"/)
  assert.match(busy, /role="status"|data-slot="spinner"|animate-spin/)
})

test('list rows use the same ledger state as the window', () => {
  const approval = { id: 'a1', candidateId: 'c1', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null }
  swr.data = { tasks: [task({ stage: 'publish', status: 'running' })] }
  ledger = { approvals: [approval], publications: [{ approvalId: 'a1', status: 'failed' }] }
  assert.match(list(), />发布失败</)
  swr.data = { tasks: [task({ stage: 'publish', status: 'running', candidateId: 'c2' })] }
  ledger = { approvals: [approval], publications: [] }
  // A new commit voids the old approval: the row is back to pending (GitHub-style).
  assert.match(list(), />待你确认</)
  assert.doesNotMatch(list(), />已失效</)
  ledger = { approvals: [{ ...approval, expiresAt: new Date(Date.now() - 1000).toISOString(), candidateId: 'c2' }], publications: [] }
  assert.match(list(), />已过期</)
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
  assert.match(bar('failed'), />发布失败<.*>撤销批准<.*>发布</)
  assert.match(bar('invalidated'), />已失效</)
  assert.doesNotMatch(bar('invalidated'), /<button/)
  assert.match(bar('checking'), />发布待核对</)
  assert.doesNotMatch(bar('invalidated'), />发布</)
})

test('pending without a decision source hides 批准; busy actions show a spinner and stay disabled', () => {
  const hidden = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} details={[]} canApprove={false} />)
  assert.doesNotMatch(hidden, /批准/)
  assert.doesNotMatch(hidden, /<button/)
  const busy = renderToStaticMarkup(<ApprovalBar state="approved" isSkill={false} details={[]} busy />)
  assert.match(busy, /aria-busy="true"[^>]*>[^<]*<svg[^>]*role="status"|aria-busy="true"/)
  assert.match(busy, /data-icon="inline-start"/)
})

test('pending shows 退回修改 only when a reject handler is passed', () => {
  const without = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} details={[]} canApprove />)
  assert.doesNotMatch(without, /退回修改/)
  const withReject = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} details={[]} canApprove onReject={() => {}} />)
  assert.match(withReject, /variant="secondary"[^<]*<?[^<]*退回修改|退回修改/)
})

test('publish failed keeps revoke and offers publish again', () => {
  const html = renderToStaticMarkup(<ApprovalBar state="failed" isSkill={false} details={[]} />)
  assert.match(html, /撤销/)
  assert.match(html, />发布</)
})

test('revoke is secondary and busy actions swap the icon for the spinner (fixed width)', () => {
  for (const state of ['approved', 'failed'] as const) {
    const idle = renderToStaticMarkup(<ApprovalBar state={state} isSkill={false} details={[]} />)
    assert.match(idle, /<button[^>]*class="[^"]*bg-secondary [^"]*"[^>]*>撤销批准</)
    const busy = renderToStaticMarkup(<ApprovalBar state={state} isSkill={false} details={[]} busy />)
    // Each action has exactly one inline-start icon whether idle or busy, so its width does not change.
    assert.equal((idle.match(/data-icon="inline-start"/g) ?? []).length, (busy.match(/data-icon="inline-start"/g) ?? []).length)
    assert.ok((idle.match(/data-icon="inline-start"/g) ?? []).length >= 1)
  }
  const pendingIdle = renderToStaticMarkup(<ApprovalBar state="pending" isSkill details={[]} />)
  const pendingBusy = renderToStaticMarkup(<ApprovalBar state="pending" isSkill details={[]} busy />)
  assert.equal((pendingIdle.match(/data-icon="inline-start"/g) ?? []).length, 1)
  assert.equal((pendingBusy.match(/data-icon="inline-start"/g) ?? []).length, 1)
})

test('a voided approval shows only the 「<sha> · 已失效」 badge next to the enable action', () => {
  const html = renderToStaticMarkup(<ApprovalBar state="pending" isSkill details={[]} superseded="ccccccc" />)
  assert.match(html, />ccccccc · 已失效</)
  assert.match(html, />启用</)
  assert.doesNotMatch(html, /<p[\s>]/)
})
