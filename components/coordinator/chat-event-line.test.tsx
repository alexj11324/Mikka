import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../messages/en.json'
import type { CitationSource } from '../../lib/coordinator/citations'
import type { AgentCitations } from '../workspace/agent-citations'

// A runtime event line names its thread by its title (a link, no icon or badge) and its task by state icon and code
// (decision 2026-11-10), then what happened.
const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
let ChatEventLine: typeof import('./chat-event-line')['ChatEventLine']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatEventLine } = await import('./chat-event-line'))
})
after(() => browser.happyDOM.close())

const TASK = '00000000-0000-4000-8000-0000000000d1'
const RUN = '00000000-0000-4000-8000-0000000000d2'
const sources: Record<string, CitationSource> = {
  [TASK]: { kind: 'issue', id: TASK, number: 45, identifier: 'ALEX-45', title: 'Create the handoff', status: 'done', priority: 'normal', run: { status: 'succeeded', outcome: 'done' }, pullRequests: [] },
  [RUN]: { kind: 'run', id: RUN, agentName: 'Worker', harness: 'codex', status: 'succeeded', outcome: 'done', issue: { id: TASK, number: 45, identifier: 'ALEX-45', title: 'Create the handoff' }, name: 'Create the handoff in Mikka', summary: null, steps: 3, createdAt: '2026-11-10T00:00:00.000Z', finishedAt: '2026-11-10T00:10:00.000Z' },
}
const citations: AgentCitations = { sources, previews: {}, onOpenIssue: () => {} }

test('an event line reads as its thread title or its task code, then what happened', async () => {
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  const render = (line: Parameters<typeof ChatEventLine>[0]['line']) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ChatEventLine line={line} citations={citations} /></NextIntlClientProvider>)
  })
  try {
    await render({ kind: 'runFinished', runId: RUN, issueId: null, status: 'succeeded', title: null })
    assert.equal(container.textContent, 'Create the handoff finished')
    assert.equal(container.querySelector('[data-thread-link] svg'), null, 'the thread has no icon')
    await render({ kind: 'issueStatus', runId: null, issueId: TASK, status: 'done', title: null })
    assert.equal(container.textContent, 'ALEX-45 moved to Done')
    assert.equal(container.querySelector('[data-task-status]')?.getAttribute('data-task-status'), 'done')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})
