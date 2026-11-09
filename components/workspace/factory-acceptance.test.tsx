import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8'))
const lookup = (key: string, args?: Record<string, string>) => {
  const value = key.split('.').reduce((node, part) => node?.[part], zh)
  assert.equal(typeof value, 'string', `missing ${key}`)
  return (value as string).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
}
const translators = new Map<string, typeof lookup>()
const translationsFor = (namespace = '') => {
  let translate = translators.get(namespace)
  if (!translate) {
    translate = (key, args) => lookup(namespace ? `${namespace}.${key}` : key, args)
    translators.set(namespace, translate)
  }
  return translate
}
let swr: { data?: unknown; error?: unknown; isLoading: boolean; mutate: () => void }
let ledger: unknown
let taskDetail: unknown
let publicFlow: unknown
const cache = new Map()
mock.module('swr', { defaultExport: (key: string) => String(key).includes('view=ledger')
  ? { data: ledger, mutate: () => {} }
  : key === '/api/factory/tasks/t1/flow' ? { data: publicFlow, mutate: () => {} }
    : key === '/api/factory/tasks/t1' && taskDetail !== undefined ? { data: taskDetail, mutate: () => {} } : swr, namedExports: { useSWRConfig: () => ({ cache, mutate: async () => undefined }) } })
// The report's CI checks row reads the review summary (its own SWR and live keys); these tests cover the flow, not that row.
mock.module(new URL('../../hooks/code-review/use-review-summary.ts', import.meta.url).href, { namedExports: { useReviewSummary: () => ({ data: undefined }) } })
mock.module('next-intl', { namedExports: { useTranslations: translationsFor, useFormatter: () => ({ dateTime: () => '', relativeTime: () => '' }), useNow: () => new Date('2026-11-05T01:00:00.000Z') } })
mock.module(new URL('./issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })

let FactoryAcceptance: typeof import('./factory-acceptance')['FactoryAcceptance']
let FactoryAcceptancePanel: typeof import('./factory-acceptance')['FactoryAcceptancePanel']
let FactoryListError: typeof import('./factory-acceptance')['FactoryListError']
let AcceptanceStateBadge: typeof import('./factory-acceptance')['AcceptanceStateBadge']
let useThreadAcceptance: typeof import('./factory-acceptance')['useThreadAcceptance']
let ApprovalBar: typeof import('./factory-approval-bar')['ApprovalBar']
before(async () => {
  ({ FactoryAcceptance, FactoryAcceptancePanel, FactoryListError, AcceptanceStateBadge, useThreadAcceptance } = await import('./factory-acceptance'))
  ;({ ApprovalBar } = await import('./factory-approval-bar'))
})
beforeEach(() => { cache.clear(); swr = { isLoading: false, mutate: () => {} }; ledger = { approvals: [], publications: [] }; taskDetail = {}; publicFlow = undefined })
const list = () => renderToStaticMarkup(<FactoryAcceptance issueId="issue-1" />)
const task = (patch: Record<string, unknown> = {}) => ({ id: 't1', issueId: 'issue-1', stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId: 'c1', candidateRunId: null, isSkillCandidate: false, ...patch })

test('a v2 producer header uses the canonical task flow, never its legacy lifecycle status', () => {
  const current = task({ stage: 'publish', status: 'passed' })
  taskDetail = { task: { ...current, route: { flowVersion: 2 } } }
  const flow = { version: 2, id: current.id, issueId: current.issueId, botId: 'bot', revision: 8,
    stage: 'handoff', stages: ['implement', 'review', 'handoff'], review: null, acceptance: null, pullRequest: null }
  const badge = () => renderToStaticMarkup(<AcceptanceStateBadge task={current} />)
  publicFlow = { ...flow, needsYou: { kind: 'pr_review', since: '2026-11-05T00:00:00Z' } }
  assert.match(badge(), />PR 待审</)
  assert.doesNotMatch(badge(), />已合并</)
  publicFlow = { ...flow, stage: 'completed', stages: [...flow.stages, 'completed'] }
  assert.match(badge(), />已合并</)
  publicFlow = { ...flow, stage: 'implement', needsYou: { kind: 'question', since: '2026-11-05T00:00:00Z' } }
  assert.match(badge(), />在问你</)
  publicFlow = undefined
  assert.equal(badge(), '', 'an unread v2 flow cannot fall back to a contradictory legacy status')
  taskDetail = undefined
  assert.equal(badge(), '', 'an unread version cannot flash a legacy completion state')
})

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
  assert.doesNotMatch(html, /text-destructive(?:-foreground)?\b/, 'the default alert: no destructive text, in the colour or its foreground')
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

test('a code candidate row reads the merge: 待你确认, 合并中, 已合并 (#528)', () => {
  const merge = (status: string) => ({ candidateId: 'c1', status, code: null, pullRequestUrl: 'https://github.com/o/r/pull/1', createdAt: new Date().toISOString() })
  swr.data = { tasks: [task()] }
  ledger = { approvals: [], publications: [], merges: [] }
  assert.match(list(), />待你确认</)
  ledger = { approvals: [], publications: [], merges: [merge('merging')] }
  assert.match(list(), />合并中</)
  swr.data = { tasks: [task({ stage: 'publish', status: 'passed' })] }
  ledger = { approvals: [], publications: [], merges: [merge('merged')] }
  assert.match(list(), />已合并</)
})

test('skill rows use the same ledger state as the window', () => {
  const approval = { id: 'a1', candidateId: 'c1', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null }
  swr.data = { tasks: [task({ stage: 'publish', status: 'running', isSkillCandidate: true })] }
  ledger = { approvals: [approval], publications: [{ approvalId: 'a1', status: 'failed' }] }
  assert.match(list(), />发布失败</)
  swr.data = { tasks: [task({ stage: 'publish', status: 'running', candidateId: 'c2', isSkillCandidate: true })] }
  ledger = { approvals: [approval], publications: [] }
  // A new commit voids the old approval: the row is back to pending (GitHub-style).
  assert.match(list(), />待启用</)
  assert.doesNotMatch(list(), />已失效</)
  ledger = { approvals: [{ ...approval, expiresAt: new Date(Date.now() - 1000).toISOString(), candidateId: 'c2' }], publications: [] }
  assert.match(list(), />已过期</)
})

test('an empty list renders nothing', () => {
  swr.data = { tasks: [] }
  assert.equal(list(), '')
})

test('an accepted report remains reachable and reads 已验收', () => {
  swr.data = { tasks: [task({ status: 'passed' })] }
  assert.match(list(), />已验收</)
})

test('host-confirmed completion recovery is reachable without exposing ordinary blocked tasks', () => {
  const blocked = task({ stage: 'execute', status: 'blocked', candidateId: null, candidateRunId: null, reason: '已完成执行等待独立检查' })
  swr.data = { tasks: [blocked] }
  assert.equal(list(), '')
  swr.data = { tasks: [{ ...blocked, completionRecovery: { binding: { taskId: blocked.id, revision: 16 } } }, task({ id: 'accepted', status: 'passed' })] }
  const html = list()
  assert.match(html, /已完成执行等待独立检查/)
  assert.match(html, /aria-label="Factory 验收"/)
  assert.match(html, />已验收</)
})

test('a host-qualified retained delivery uses the existing retry control from a waiting review', () => {
  const waiting = task({ stage: 'review', status: 'waiting', candidateRunId: 'original-producer', revision: 21,
    reason: '交付快照等待恢复' })
  swr.data = { tasks: [waiting] }
  assert.equal(list(), '')
  const completionRecovery = { binding: { taskId: waiting.id, revision: 21 } }
  swr.data = { tasks: [{ ...waiting, completionRecovery }] }
  assert.match(list(), /交付快照等待恢复/)
  taskDetail = { task: waiting, completionRecovery, checks: [] }
  const panel = renderToStaticMarkup(<FactoryAcceptancePanel task={{ ...waiting, completionRecovery }} onClose={() => {}} />)
  assert.match(panel, />重试</)
  assert.doesNotMatch(panel, />验收并合并</)
})

test('an open completion recovery panel follows the same task to its accepted candidate', () => {
  const initial = task({ stage: 'execute', status: 'blocked', candidateId: null, candidateRunId: null,
    revision: 16, completionRecovery: { binding: { taskId: 't1', revision: 16 } } })
  taskDetail = { task: { stage: 'review', status: 'running', candidateId: 'c1', revision: 18 } }
  swr.data = { tasks: [task({ status: 'pending', candidateRunId: 'producer', revision: 23 })] }
  assert.match(renderToStaticMarkup(<FactoryAcceptancePanel task={initial} onClose={() => {}} />), />待你确认</)
  swr.data = { tasks: [task({ status: 'passed', candidateRunId: 'producer', revision: 24 })] }
  const html = renderToStaticMarkup(<FactoryAcceptancePanel task={initial} onClose={() => {}} />)
  assert.match(html, />已验收</)
  assert.doesNotMatch(html, />重试</)
})

// The card must survive a 200 response that is not `{ tasks: [...] }`: an HTML
// fallback parses to `{}`, and an older API may send no `tasks` at all.
test('a response without a tasks array renders nothing instead of throwing', () => {
  for (const data of [{}, { tasks: null }, { tasks: 'nope' }]) {
    swr = { data, isLoading: false, mutate: () => {} }
    assert.equal(list(), '')
  }
})

test('skill rows read 待启用 and ordinary rows keep 待你确认', () => {
  swr.data = { tasks: [task({ isSkillCandidate: true })] }
  assert.match(list(), />待启用</)
  swr.data = { tasks: [task()] }
  assert.match(list(), />待你确认</)
})

test('approval bar uses component defaults and the Figma copy for each state', () => {
  const bar = (state: Parameters<typeof ApprovalBar>[0]['state'], isSkill = false) =>
    renderToStaticMarkup(<ApprovalBar state={state} isSkill={isSkill} />)
  for (const state of ['pending', 'approved', 'publishing', 'checking', 'failed', 'live', 'revoked', 'expired', 'invalidated'] as const) {
    const html = bar(state)
    assert.match(html, /data-slot="item"/)
    // `bg-control` is the secondary Button's own default (R-31), so it no longer marks a call-site override.
    assert.doesNotMatch(html, /rounded-\[14px\]|line-through|bg-blue|bg-destructive/)
  }
  // While it waits for you the header's chip names the state; the bar carries only the scope and the action.
  assert.doesNotMatch(bar('pending', true), />待启用</)
  assert.match(bar('pending', true), />启用</)
  assert.match(bar('live', true), />已启用</)
  assert.match(bar('failed'), />发布失败<.*>撤销批准<.*>发布</)
  assert.match(bar('invalidated'), />已失效</)
  assert.doesNotMatch(bar('invalidated'), /<button/)
  assert.match(bar('checking'), />发布待核对</)
  assert.doesNotMatch(bar('invalidated'), />发布</)
})

test('pending without a decision source hides 批准; busy actions show a spinner and stay disabled', () => {
  const hidden = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} canApprove={false} />)
  assert.doesNotMatch(hidden, /批准/)
  assert.doesNotMatch(hidden, /<button/)
  const busy = renderToStaticMarkup(<ApprovalBar state="approved" isSkill={false} busy />)
  assert.match(busy, /aria-busy="true"[^>]*>[^<]*<svg[^>]*role="status"|aria-busy="true"/)
  assert.match(busy, /data-icon="inline-start"/)
})

test('pending shows 退回修改 only when a reject handler is passed', () => {
  const without = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} canApprove />)
  assert.doesNotMatch(without, /退回修改/)
  const withReject = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} canApprove onReject={() => {}} />)
  assert.match(withReject, /variant="secondary"[^<]*<?[^<]*退回修改|退回修改/)
})

test('a refused merge leads with 在 GitHub 打开 and offers merging again as secondary, two actions at most', () => {
  const html = renderToStaticMarkup(<ApprovalBar state="pending" isSkill={false} canApprove onReject={() => {}} onAccept={() => {}} refusal="githubMergeBlocked" pullRequestUrl="https://github.com/o/r/pull/1" />)
  assert.equal((html.match(/data-slot="button"/g) ?? []).length, 2)
  assert.match(html, /data-button-variant="default"[^>]*>(<svg[^>]*>.*?<\/svg>)?在 GitHub 打开/)
  assert.match(html, /data-button-variant="secondary"[^>]*>.*?验收并合并/)
  assert.doesNotMatch(html, /退回修改/)
})

test('publish failed keeps revoke and offers publish again', () => {
  const html = renderToStaticMarkup(<ApprovalBar state="failed" isSkill={false} />)
  assert.match(html, /撤销/)
  assert.match(html, />发布</)
})

test('revoke is secondary and busy actions swap the icon for the spinner (fixed width)', () => {
  for (const state of ['approved', 'failed'] as const) {
    const idle = renderToStaticMarkup(<ApprovalBar state={state} isSkill={false} />)
    assert.match(idle, /<button[^>]*data-button-variant="secondary"[^>]*>撤销批准</)
    const busy = renderToStaticMarkup(<ApprovalBar state={state} isSkill={false} busy />)
    // Each action has exactly one inline-start icon whether idle or busy, so its width does not change.
    assert.equal((idle.match(/data-icon="inline-start"/g) ?? []).length, (busy.match(/data-icon="inline-start"/g) ?? []).length)
    assert.ok((idle.match(/data-icon="inline-start"/g) ?? []).length >= 1)
  }
  const pendingIdle = renderToStaticMarkup(<ApprovalBar state="pending" isSkill />)
  const pendingBusy = renderToStaticMarkup(<ApprovalBar state="pending" isSkill busy />)
  assert.equal((pendingIdle.match(/data-icon="inline-start"/g) ?? []).length, 1)
  assert.equal((pendingBusy.match(/data-icon="inline-start"/g) ?? []).length, 1)
})

test('a voided approval shows only the 「<sha> · 已失效」 badge next to the enable action', () => {
  const html = renderToStaticMarkup(<ApprovalBar state="pending" isSkill superseded={'c'.repeat(40)} />)
  assert.match(html, />ccccccc · 已失效</)
  assert.doesNotMatch(html, />c{8,}/)
  assert.match(html, />启用</)
  assert.doesNotMatch(html, /<p[\s>]/)
})

test('every sha shows 7 characters; the full sha is the copy target and the hover label', () => {
  const full = '3f9c2ab' + 'e'.repeat(33)
  const html = renderToStaticMarkup(<ApprovalBar state="approved" isSkill={false} sha={full} superseded={'d'.repeat(40)} />)
  assert.match(html, />3f9c2ab</)
  assert.doesNotMatch(html, />3f9c2abe/)
  assert.match(html, new RegExp(`<button[^>]*data-sha="${full}"`))
  assert.match(html, new RegExp(`aria-label="复制完整 sha ${full}"`))
  assert.match(html, />ddddddd · 已失效</)
})

test('failed and active fixed-candidate checks remain in the list with their own state labels', () => {
  const labels = { review: { failed: '审阅未通过', pending: '等待审阅', running: '审阅中' },
    verify: { failed: '验证未通过', pending: '等待验证', running: '验证中' } }
  for (const stage of ['review', 'verify'] as const) for (const status of ['failed', 'pending', 'running'] as const) {
    swr.data = { tasks: [task({ stage, status, candidateRunId: 'producer' })] }
    assert.match(list(), new RegExp('>' + labels[stage][status] + '<'))
    assert.doesNotMatch(list(), /发布失败|待你确认|不可批准/)
  }
  swr.data = { tasks: [task({ stage: 'review', status: 'failed', candidateId: null })] }
  assert.equal(list(), '')
})

test('the same producer thread keeps its acceptance tab through retry states', () => {
  function Header({ runId }: { runId: string }) {
    const acceptance = useThreadAcceptance('issue-1', runId)
    return acceptance ? <span>{acceptance.id}</span> : null
  }
  for (const status of ['failed', 'pending', 'running']) {
    swr.data = { tasks: [task({ stage: 'review', status, candidateRunId: 'producer' })] }
    assert.equal(renderToStaticMarkup(<Header runId="producer" />), '<span>t1</span>')
    assert.equal(renderToStaticMarkup(<Header runId="another-thread" />), '')
  }
})

test('blocked fixed-candidate review and verification remain visible as blocked, not a failed verdict', () => {
  for (const stage of ['review', 'verify'] as const) {
    swr.data = { tasks: [task({ stage, status: 'blocked', candidateRunId: 'producer',
      reason: 'Question recovery blocked: factoryQuestionRunMismatch' })] }
    const html = list()
    assert.match(html, /aria-label="Factory 验收"/)
    assert.match(html, /受阻/)
    assert.doesNotMatch(html, /审阅未通过|验证未通过|需要修改|进行中|发布失败|待你确认|不可批准/)
  }
})

test('a blocked check keeps only its producer thread acceptance entry', () => {
  function Header({ runId }: { runId: string }) {
    const acceptance = useThreadAcceptance('issue-1', runId)
    return acceptance ? <span>{acceptance.id}</span> : null
  }
  swr.data = { tasks: [task({ stage: 'review', status: 'blocked', candidateRunId: 'producer' })] }
  assert.equal(renderToStaticMarkup(<Header runId="producer" />), '<span>t1</span>')
  assert.equal(renderToStaticMarkup(<Header runId="another-thread" />), '')
})
