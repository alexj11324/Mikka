import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThreadApprovalView } from '@/lib/live/tool-approval-cache'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, Record<string, unknown>>>
const copy = (namespace: string) => {
  const table = namespace.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], zh)
  return (key: string, values: Record<string, unknown> = {}) => {
    const found = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], table)
    return String(typeof found === 'string' ? found : key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
  }
}
mock.module('next-intl', { namedExports: { useTranslations: copy } })

// The wiring test below renders the component that owns the hook; every other
// test renders the content directly. The stub records the run it was asked for.
const asked: { runId: string; active: boolean }[] = []
mock.module('@/hooks/use-tool-approvals', { namedExports: { useToolApprovals: (runId: string, active: boolean) => {
  asked.push({ runId, active })
  return { approvals: [approval({ runId })], busy: null, failure: null, mutate: async () => {}, decide: async () => {} }
} } })

let Content: typeof import('./thread-tool-approval')['ThreadApprovalCardsContent']
let Cards: typeof import('./thread-tool-approval')['ThreadApprovalCards']
before(async () => { ({ ThreadApprovalCardsContent: Content, ThreadApprovalCards: Cards } = await import('./thread-tool-approval')) })

const now = Date.now()
const approval = (over: Partial<ThreadApprovalView> = {}): ThreadApprovalView => ({
  approvalId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002',
  status: 'pending', method: 'command', tool: 'Bash', input: { command: 'npm test' },
  createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(), ...over,
})

test('a pending request shows the exact command and both decisions', () => {
  const html = renderToStaticMarkup(<Content approvals={[approval()]} />)
  assert.match(html, /data-slot="thread-approvals"/)
  assert.match(html, /data-approval="pending"/)
  assert.match(html, /需要你批准/)
  assert.match(html, /命令/)
  assert.match(html, /Bash/)
  assert.match(html, /npm test/)
  assert.match(html, /允许一次/)
  assert.match(html, /拒绝/)
})

test('an approved request waits for the Agent and cannot be decided again', () => {
  const html = renderToStaticMarkup(<Content approvals={[approval({ status: 'approved' })]} />)
  assert.match(html, /已允许，等待 Agent 执行。/)
  assert.doesNotMatch(html, /允许一次/)
  assert.doesNotMatch(html, /<button/)
})

test('a denied request says so and offers no action', () => {
  const html = renderToStaticMarkup(<Content approvals={[approval({ status: 'denied' })]} />)
  assert.match(html, /已拒绝。/)
  assert.doesNotMatch(html, /<button/)
})

test('a pending request past its deadline renders as expired, never as runnable', () => {
  const html = renderToStaticMarkup(<Content approvals={[approval({ expiresAt: new Date(now - 1000).toISOString() })]} />)
  assert.match(html, /data-approval="expired"/)
  assert.match(html, /已过期，未执行。/)
  assert.doesNotMatch(html, /允许一次/)
})

test('a decision in flight disables both buttons and a refusal is an alert', () => {
  const html = renderToStaticMarkup(<Content approvals={[approval()]} busy={approval().approvalId} failure="approvalNoLongerApplies" />)
  assert.ok((html.match(/disabled=""/g)?.length ?? 0) >= 2)
  assert.match(html, /role="alert"/)
  assert.match(html, /这个请求已失效。/)
})

test('no cards and no failure draw nothing', () => {
  assert.equal(renderToStaticMarkup(<Content approvals={[]} />), '')
})

test('an answered question reads the continuation run’s approvals, not the root run’s', () => {
  // Answering a question starts a continuation; its Ask requests hang off that
  // run, so the card must be bound to the run executing now.
  const liveRunId = '00000000-0000-4000-8000-0000000000cc'
  const html = renderToStaticMarkup(<Cards runId={liveRunId} active />)
  assert.deepEqual(asked.at(-1), { runId: liveRunId, active: true })
  // What the continuation asked is what the person sees.
  assert.match(html, /data-slot="thread-approvals"/)
  assert.match(html, /data-approval="pending"/)
  assert.match(html, /允许一次/)
})
