import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en.json'
import type { CitationSource } from '../lib/coordinator/citations'
import { taskPresentation } from '../lib/task-presentation'

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
  [TASK]: { kind: 'issue', id: TASK, number: 4, identifier: 'ZHIX-4', title: 'Rebuild the shell', status: 'doing', priority: 'high', run: { status: 'running', outcome: null }, pullRequests: [] },
}
const run = (id: string, status: string, name: string): CitationSource => ({ kind: 'run', id, agentName: 'Worker', harness: 'claude_code', status, issue: { id: TASK, number: 4, identifier: 'ZHIX-4', title: 'Rebuild the shell' }, name, summary: null, steps: 1, createdAt: '2026-11-01T00:00:00.000Z', finishedAt: null })
const RUNS = { running: '00000000-0000-4000-8000-0000000000a1', failed: '00000000-0000-4000-8000-0000000000a2', succeeded: '00000000-0000-4000-8000-0000000000a3' } as const
for (const [status, id] of Object.entries(RUNS)) sources[id] = run(id, status, `Thread ${status}`)
// The succeeded run was judged done (R-52): only then is it 已解决.
sources[RUNS.succeeded] = { ...sources[RUNS.succeeded], outcome: 'done' } as CitationSource

const issue = (id: string, patch: Partial<Extract<CitationSource, { kind: 'issue' }>>): CitationSource => ({ kind: 'issue', id, number: 5, identifier: 'ZHIX-5', title: 'Task', status: 'doing', priority: 'normal', ...patch })

test('a task chip uses the same authorized presentation as its detail, including a threadless task and Factory review', async () => {
  const { AgentCitationsContext, CitationChip } = citations
  const { TaskPresentationsContext } = await import('../hooks/use-task-collection')
  const ids = Array.from({ length: 7 }, (_, n) => `00000000-0000-4000-8000-0000000000b${n}`)
  const tasks: Record<string, CitationSource> = {
    [ids[0]]: issue(ids[0], { run: { status: 'running', outcome: null } }),
    [ids[1]]: issue(ids[1], { run: { status: 'succeeded', outcome: 'failed' } }),
    [ids[2]]: issue(ids[2], { run: { status: 'succeeded', outcome: 'blocked' } }),
    [ids[3]]: issue(ids[3], { run: null }),
    // A done run whose PR is open waits for review: the task's state, never the run's result.
    [ids[4]]: issue(ids[4], { run: { status: 'succeeded', outcome: 'done' }, pullRequests: [{ url: 'https://github.com/a/b/pull/1', state: 'open' }] }),
    [ids[5]]: issue(ids[5], { status: 'backlog', run: null }),
    // An older citation retains its title when it has no code.
    [ids[6]]: issue(ids[6], { status: 'done', identifier: null, title: 'Ship it' }),
  }
  const current = { status: 'doing' as const, metadata: { pullRequests: [] } }
  const projections = [
    taskPresentation(current, { runId: 'r', status: 'running', outcome: null }, null, () => false),
    taskPresentation(current, { runId: 'r', status: 'failed', outcome: 'failed' }, null, () => false),
    taskPresentation(current, { runId: 'r', status: 'succeeded', outcome: 'blocked' }, null, () => false),
    taskPresentation(current, undefined, { stage: 'handoff', needsYou: { kind: 'spec_review', since: '2026-11-01' } }, () => false),
    taskPresentation(current, undefined, { stage: 'handoff', needsYou: { kind: 'pr_review', since: '2026-11-01' } }, () => false),
    taskPresentation({ ...current, status: 'backlog' }, undefined, null, () => false),
    taskPresentation({ ...current, status: 'done' }, undefined, null, () => false),
  ]
  const opened: string[] = []
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <TaskPresentationsContext value={Object.fromEntries(ids.map((id, index) => [id, projections[index]]))}>
      <AgentCitationsContext value={{ sources: tasks, previews: {}, onOpenIssue: id => opened.push(id) }}>
        {ids.map(id => <CitationChip key={id} id={id} kind="issue" />)}
      </AgentCitationsContext>
      </TaskPresentationsContext>
    </NextIntlClientProvider>)
  })
  try {
    const chips = [...container.querySelectorAll('[data-slot="inline-citation-trigger"]')] as HTMLElement[]
    // One status, the task's status field (2026-11-13-1405); what its Agent is doing is the small mark after it.
    assert.deepEqual(chips.map(chip => chip.querySelector('[data-task-status]')?.getAttribute('data-task-status')), ['doing', 'doing', 'doing', 'doing', 'doing', 'backlog', 'done'])
    assert.deepEqual(chips.map(chip => chip.querySelector('[data-run-indicator]')?.getAttribute('data-run-indicator') ?? null), ['working', 'error', 'waiting', 'waiting', 'waiting', null, null])
    await act(async () => { chips[3].click(); chips[5].click() })
    assert.deepEqual(opened, [ids[3], ids[5]])
    assert.deepEqual(chips.map(chip => chip.textContent), ['ZHIX-5', 'ZHIX-5', 'ZHIX-5', 'ZHIX-5', 'ZHIX-5', 'ZHIX-5', 'Ship it'])
    assert.equal(chips[0].querySelector('svg')?.getAttribute('viewBox'), '0 0 12 12', '进行中 is the status ring, whatever the run does')
    assert.ok(chips[0].querySelector('[data-run-indicator] svg')?.getAttribute('class')?.includes('lucide-loader-circle'), 'a working Agent is the small turning mark')
    assert.ok(chips[3].querySelector('[data-run-indicator] svg')?.getAttribute('class')?.includes('lucide-hand'), 'waiting for the person is the hand')
    assert.equal(chips[6].getAttribute('aria-label'), 'Open task: Ship it')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
})

test('a thread without a task opens its conversation from its title, with click and keyboard', async () => {
  const { setWorkAreaOpener } = await import('../components/workspace/workspace-navigation')
  const opened: string[] = []
  const release = setWorkAreaOpener({ task: () => assert.fail('a standalone thread must not open a task'), thread: id => { opened.push(id) } })
  const standalone = { ...run(RUNS.running, 'running', 'Check the logs'), issue: null } as CitationSource
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <citations.AgentCitationsContext value={{ sources: { [RUNS.running]: standalone }, previews: {}, onOpenIssue: () => assert.fail('no task') }}>
          <citations.CitationChip id={RUNS.running} kind="run" />
        </citations.AgentCitationsContext>
      </NextIntlClientProvider>)
    })
    const link = container.querySelector('[data-thread-link]') as HTMLElement
    assert.equal(link.textContent, 'Check the logs')
    await act(async () => { link.click() })
    await act(async () => { link.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event) })
    assert.deepEqual(opened, [RUNS.running, RUNS.running])
  } finally {
    release()
    await act(async () => { root.unmount() })
    container.remove()
  }
})

test('a thread is its title as a link, no icon or badge, and opens the thread beside the chat (?thread=); only a task chip opens the task', async () => {
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
    assert.equal(taskChip.textContent, 'ZHIX-4')
    // The task's title, without the code the task chip already carries; nothing else on it (decision 2026-11-10).
    assert.deepEqual(threadChips.map(chip => chip.textContent), ['Rebuild the shell', 'Rebuild the shell', 'Rebuild the shell'])
    for (const chip of threadChips) {
      assert.equal(chip.querySelector('svg, [role="img"], [data-thread-attention]'), null, 'no icon, dot or badge')
      assert.match(chip.className, /text-object-chip-foreground/, 'thread titles use the existing citation link colour')
      assert.doesNotMatch(chip.className, /(^| )text-primary( |$)/, 'hosted primary is body black, not the citation link colour')
      assert.match(chip.className, /bg-transparent/)
      assert.doesNotMatch(chip.className, /(^| )bg-object-chip( |$)/, 'no boxed fill')
      assert.match(chip.className, /focus-visible:ring-2/)
      assert.equal(chip.getAttribute('role'), 'button')
      assert.equal(chip.getAttribute('tabindex'), '0')
    }
    assert.equal(threadChips[0].getAttribute('aria-label'), 'Open thread: Rebuild the shell')
    await act(async () => { threadChips[1].click() })
    // The thread's address, written through the navigation module; the workspace shows it in the right column (R-80).
    assert.equal(new URL(browser.location.href).searchParams.get('thread'), RUNS.failed)
    assert.equal(opened.moves, 1)
    assert.deepEqual(opened.issues, [], 'a thread chip never opens the task')
    await act(async () => { threadChips[2].dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event) })
    assert.equal(new URL(browser.location.href).searchParams.get('thread'), RUNS.succeeded, 'Enter opens a thread too')
    await act(async () => { taskChip.click() })
    assert.deepEqual(opened.issues, [TASK])
    // An object chip is an inline span so a long title wraps (R-15); Enter still opens it, as a button's would.
    assert.equal(taskChip.getAttribute('role'), 'button')
    await act(async () => { taskChip.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event) })
    assert.deepEqual(opened.issues, [TASK, TASK])
  } finally {
    browser.removeEventListener('mikka:navigate', counted)
    await act(async () => { root.unmount() })
    container.remove()
  }
})
