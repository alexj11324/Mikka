import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en.json'
import type { CitationSource } from '../lib/coordinator/citations'

const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
let citations: typeof import('../components/workspace/agent-citations')
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  citations = await import('../components/workspace/agent-citations')
})

const TASK = '00000000-0000-4000-8000-000000000043'
const sources: Record<string, CitationSource> = {
  [TASK]: { kind: 'issue', id: TASK, number: 4, identifier: 'ZHIX-4', title: 'Rebuild the shell', status: 'doing', priority: 'high' },
}
const run = (id: string, status: string, name: string): CitationSource => ({ kind: 'run', id, agentName: 'Worker', harness: 'claude_code', status, issue: { id: TASK, number: 4, identifier: 'ZHIX-4', title: 'Rebuild the shell' }, name, summary: null, steps: 1, createdAt: '2026-11-01T00:00:00.000Z', finishedAt: null })
const RUNS = { running: '00000000-0000-4000-8000-0000000000a1', failed: '00000000-0000-4000-8000-0000000000a2', succeeded: '00000000-0000-4000-8000-0000000000a3' } as const
for (const [status, id] of Object.entries(RUNS)) sources[id] = run(id, status, `Thread ${status}`)

test('a thread chip shows its status and opens the thread\'s conversation; only a task chip opens the task', async () => {
  const opened: { issues: string[]; threads: { issueId: string; runId: string }[] } = { issues: [], threads: [] }
  const { AgentCitationsContext, CitationChip } = citations
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <AgentCitationsContext value={{ sources, previews: {}, onOpenIssue: id => { opened.issues.push(id) }, onOpenThread: thread => { opened.threads.push(thread) } }}>
        <CitationChip id={TASK} kind="issue" />
        {Object.values(RUNS).map(id => <CitationChip key={id} id={id} kind="run" />)}
      </AgentCitationsContext>
    </NextIntlClientProvider>)
  })
  try {
    const chips = [...container.querySelectorAll('[data-slot="inline-citation-trigger"]')] as HTMLElement[]
    assert.equal(chips.length, 4)
    const [taskChip, ...threadChips] = chips
    // Each thread chip leads with the thread's status, the same marks as the thread card.
    assert.deepEqual(threadChips.map(chip => chip.querySelector('[role="img"]')?.getAttribute('aria-label')), ['Running', 'Failed', 'Succeeded'])
    assert.ok(threadChips[0].querySelector('svg')?.getAttribute('class')?.includes('animate-spin'))
    assert.ok(threadChips[1].querySelector('svg')?.getAttribute('class')?.includes('text-destructive'))
    assert.ok(threadChips[2].querySelector('svg')?.getAttribute('class')?.includes('text-success'))
    assert.equal(threadChips[0].getAttribute('aria-label'), 'Open thread: Thread running')
    await act(async () => { threadChips[1].click() })
    assert.deepEqual(opened.threads, [{ issueId: TASK, runId: RUNS.failed }])
    assert.deepEqual(opened.issues, [], 'a thread chip never opens the task')
    await act(async () => { taskChip.click() })
    assert.deepEqual(opened.issues, [TASK])
    assert.equal(opened.threads.length, 1)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})
