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
// The succeeded run was judged done (R-52): only then is it 已解决.
sources[RUNS.succeeded] = { ...sources[RUNS.succeeded], outcome: 'done' } as CitationSource

test('a thread chip shows its status and opens the thread beside the chat (?thread=); only a task chip opens the task', async () => {
  const opened: { issues: string[]; moves: number } = { issues: [], moves: 0 }
  const counted = () => { opened.moves++ }
  browser.addEventListener('mikka:navigate', counted)
  const { AgentCitationsContext, CitationChip } = citations
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <AgentCitationsContext value={{ sources, previews: {}, onOpenIssue: id => { opened.issues.push(id) } }}>
        <CitationChip id={TASK} kind="issue" />
        {Object.values(RUNS).map(id => <CitationChip key={id} id={id} kind="run" />)}
      </AgentCitationsContext>
    </NextIntlClientProvider>)
  })
  try {
    const chips = [...container.querySelectorAll('[data-slot="inline-citation-trigger"]')] as HTMLElement[]
    assert.equal(chips.length, 4)
    const [taskChip, ...threadChips] = chips
    // Each thread chip leads with a bubble, its group a dot on it (R-52), the same marks as the thread card and the list.
    assert.deepEqual(threadChips.map(chip => chip.querySelector('[role="img"]')?.getAttribute('aria-label')), ['Running', 'Blocked', 'Resolved'])
    // Only a state that needs the person shows on the chip, as a dot and its word together (R-87); the rest is in the hover card.
    assert.deepEqual(threadChips.map(chip => chip.querySelector('[data-thread-dot]')?.getAttribute('data-thread-dot') ?? null), [null, 'blocked', null])
    assert.deepEqual(threadChips.map(chip => chip.querySelector('[data-thread-attention]')?.textContent ?? null), [null, 'Blocked', null])
    for (const chip of threadChips) assert.ok(chip.querySelector('svg')?.getAttribute('class')?.includes('lucide-message-circle'), 'a thread is a bubble, never a task\'s circle')
    assert.equal(threadChips[0].getAttribute('aria-label'), 'Open thread: ZHIX-4 Rebuild the shell')
    await act(async () => { threadChips[1].click() })
    // The thread's address, written through the navigation module; the workspace shows it in the right column (R-80).
    assert.equal(new URL(browser.location.href).searchParams.get('thread'), RUNS.failed)
    assert.equal(opened.moves, 1)
    assert.deepEqual(opened.issues, [], 'a thread chip never opens the task')
    await act(async () => { taskChip.click() })
    assert.deepEqual(opened.issues, [TASK])
    // An object chip is an inline span so a long title wraps (R-15); Enter still opens it, as a button's would.
    assert.equal(taskChip.getAttribute('role'), 'button')
    await act(async () => { taskChip.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event) })
    assert.deepEqual(opened.issues, [TASK, TASK])
    assert.equal(opened.moves, 1)
  } finally {
    browser.removeEventListener('mikka:navigate', counted)
    await act(async () => { root.unmount() })
    container.remove()
  }
})
