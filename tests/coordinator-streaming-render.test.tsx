import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en.json'
import { withoutPartialCitation, type CitationSource } from '../lib/coordinator/citations'
import type { AgentCitations } from '../components/workspace/agent-citations'

// Streaming a Coordinator reply: a token redraws only the reply that is arriving, and a task or thread chip never
// shows its marker or id on the way, however the tokens are cut.
// A stored reply's reasoning, as the server action would return it for these positions (masked).
const reasoningCalls: [string | null, readonly number[]][] = []
mock.module(new URL('../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  coordinatorReasoning: async (botId: string | null, positions: readonly number[]) => { reasoningCalls.push([botId, positions]); return 'Check the login redirect first.' },
} })
const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
let CoordinatorReply: typeof import('../components/coordinator/coordinator-reply')['CoordinatorReply']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, customElements: browser.customElements, Node: browser.Node, ShadowRoot: browser.ShadowRoot, MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CoordinatorReply } = await import('../components/coordinator/coordinator-reply'))
})
after(() => browser.happyDOM.close())

const TASK = '0a5c49d1-0d4d-489c-8f9e-0000000000a1'
const NEW_TASK = '1a1ee505-dba6-4a00-9100-0000000000b2'
const THREAD = '2b2ff606-ecb7-4b11-a211-0000000000c3'
const issue = (id: string, title: string): CitationSource => ({ kind: 'issue', id, number: 1, identifier: 'MIK-1', title, status: 'doing', priority: 'normal' })
const thread: CitationSource = { kind: 'run', id: THREAD, agentName: 'Worker', harness: 'claude_code', status: 'running', issue: null, name: 'Fix sign-in redirect', summary: null, steps: 1, createdAt: '2026-11-01T00:00:00.000Z', finishedAt: null }
const known = { [TASK]: issue(TASK, 'Release checklist') }
const base: AgentCitations = { sources: known, previews: {}, onOpenIssue: () => {} }
const MARKUP = /\[\[|\]\]|issue:|run:|[0-9a-f]{8}-[0-9a-f]{4}/

async function mount() {
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  const render = (children: ReactNode) => act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{children}</NextIntlClientProvider>) })
  return { container, render, unmount: () => act(async () => root.unmount()) }
}

/** Every prefix of `text` as tokens of the given sizes, cycling. */
function batches(text: string, sizes: number[]) {
  const out: string[] = []
  for (let at = 0, n = 0; at < text.length; n++) { at = Math.min(text.length, at + sizes[n % sizes.length]); out.push(text.slice(0, at)) }
  return out
}

test('a citation still arriving is left out of streamed text, whatever its cut', () => {
  const marker = `[[issue:${TASK}]]`
  for (let cut = 1; cut < marker.length; cut++) assert.equal(withoutPartialCitation(`Working on ${marker.slice(0, cut)}`), 'Working on ', marker.slice(0, cut))
  assert.equal(withoutPartialCitation(`Working on ${marker}`), `Working on ${marker}`, 'a whole marker stays for its chip')
  assert.equal(withoutPartialCitation(`[[run:${THREAD.slice(0, 9)}`), '')
  assert.equal(withoutPartialCitation('Done.'), 'Done.')
  assert.equal(withoutPartialCitation('a [[note]] here'), 'a [[note]] here', 'only a marker at the end is held back')
})

test('streamed tokens, in any batches, never show a chip marker or id; each chip shows once complete', async () => {
  const reply = `Looked at it. [[issue:${TASK}]] is building, [[issue:${NEW_TASK}]] is new and [[run:${THREAD}]] is on it.`
  for (const sizes of [[1], [3], [2, 5, 1, 7], [11, 4]]) {
    const view = await mount()
    try {
      for (const text of batches(reply, sizes)) {
        await view.render(<CoordinatorReply text={text} citations={{ ...base, pending: true }} isStreaming />)
        assert.doesNotMatch(view.container.textContent ?? '', MARKUP, `sizes ${sizes}: ${text}`)
      }
      // The task already in the chat shows as its chip; the ones not looked up yet hold their place.
      assert.equal(view.container.querySelectorAll('[data-slot="inline-citation-trigger"]').length, 1)
      assert.equal(view.container.querySelectorAll('[data-citation-pending]').length, 2)
      // Looked up: every chip shows, still mid-stream.
      const found = { ...base, pending: true, sources: { ...known, [NEW_TASK]: issue(NEW_TASK, 'Sign-in redirect'), [THREAD]: thread } }
      await view.render(<CoordinatorReply text={reply} citations={found} isStreaming />)
      assert.equal(view.container.querySelectorAll('[data-slot="inline-citation-trigger"]').length, 3)
      assert.equal(view.container.querySelectorAll('[data-citation-pending]').length, 0)
      assert.doesNotMatch(view.container.textContent ?? '', MARKUP)
    } finally { await view.unmount() }
  }
})

test('an OpenUI chip whose id is still arriving or unknown holds its place instead of showing the id', async () => {
  const program = `root = Stack([TextContent("On it"), TaskChip("${NEW_TASK}")])`
  const view = await mount()
  try {
    for (const text of batches(program, [4, 9])) {
      await view.render(<CoordinatorReply text={text} citations={{ ...base, pending: true }} isStreaming />)
      assert.doesNotMatch(view.container.textContent ?? '', MARKUP, text)
    }
  } finally { await view.unmount() }
})

// Bounded: remounting on every redraw ran away here (memory grew to the container's limit) before the fix.
test('a token for the streaming reply leaves finished replies and their chips mounted', { timeout: 20_000 }, async () => {
  const done = [`First: [[issue:${TASK}]].\n\n| Step | State |\n| --- | --- |\n| Build | done |`, `Then [[issue:${TASK}]] again.`]
  const view = await mount()
  // Where nodes were taken out: a remount inside a finished reply removes nodes under it.
  const removedFrom: Element[] = []
  const observer = new browser.MutationObserver(records => { for (const record of records) if (record.removedNodes.length) removedFrom.push(record.target as unknown as Element) })
  try {
    const chat = (text: string, citations: AgentCitations) => <>
      {done.map((text, index) => <div key={index} data-done=""><CoordinatorReply text={text} citations={citations} /></div>)}
      <div data-live=""><CoordinatorReply text={text} citations={{ ...citations, pending: true }} isStreaming /></div>
    </>
    await view.render(chat('Looking', base))
    const chips = [...view.container.querySelectorAll('[data-done] [data-slot="inline-citation-trigger"]')]
    const tables = [...view.container.querySelectorAll('[data-done] table')]
    assert.equal(chips.length, 2)
    assert.equal(tables.length, 1)
    observer.observe(view.container as unknown as import('happy-dom').Node, { subtree: true, childList: true })
    for (const text of batches(`Looking into [[issue:${TASK}]] and the build now.`, [2, 3, 1])) {
      // Even redrawn with a fresh citations object (so the memo does not skip it), a finished reply keeps its elements.
      await view.render(chat(text, { ...base }))
    }
    const stillThere = [...view.container.querySelectorAll('[data-done] [data-slot="inline-citation-trigger"]')]
    assert.equal(stillThere.length, 2)
    stillThere.forEach((chip, index) => assert.equal(chip, chips[index], 'a finished reply keeps its chip element'))
    assert.equal(view.container.querySelector('[data-done] table'), tables[0], 'a finished reply keeps its table element')
    assert.equal(removedFrom.filter(target => target.closest?.('[data-done]')).length, 0, 'nothing in a finished reply was removed')
  } finally { observer.disconnect(); await view.unmount() }
})

test('the streaming reply keeps its earlier chips mounted as new tokens arrive', { timeout: 20_000 }, async () => {
  const view = await mount()
  try {
    const reply = `Started on [[issue:${TASK}]]. The build is running and should finish in a few minutes.`
    const steps = batches(reply, [3, 2, 5])
    const at = steps.findIndex(text => text.includes(']]'))
    await view.render(<CoordinatorReply text={steps[at]} citations={{ ...base, pending: true }} isStreaming />)
    const chip = view.container.querySelector('[data-slot="inline-citation-trigger"]')
    assert.ok(chip)
    for (const text of steps.slice(at + 1)) await view.render(<CoordinatorReply text={text} citations={{ ...base, pending: true }} isStreaming />)
    assert.equal(view.container.querySelector('[data-slot="inline-citation-trigger"]'), chip, 'the chip is the same element after more tokens')
  } finally { await view.unmount() }
})

test('a reply shows its thinking and each tool by name and state with AI Elements; previews open on demand', async () => {
  const { ReplyActivity } = await import('../components/coordinator/reply-activity')
  const view = await mount()
  try {
    const tools = [
      { call: 'c1', name: 'create_issue', state: 'done' as const, input: '{"title":"Fix login"}', output: '{"id":"i1"}' },
      { call: 'c2', name: 'dispatch_run', state: 'running' as const },
      { call: 'c3', name: 'some_internal_tool', state: 'error' as const, output: 'no device' },
    ]
    await view.render(<ReplyActivity tools={tools} thinking={{ active: true, seconds: 1 }} />)
    const text = () => view.container.textContent ?? ''
    assert.equal(view.container.querySelector('[data-activity-thinking]')?.getAttribute('data-activity-thinking'), 'active')
    assert.match(view.container.querySelector('[data-activity-thinking]')?.textContent ?? '', /^Thinking$/)
    // AI Elements Tool: our label as its title, the AI SDK state as its badge; internal names never show.
    assert.deepEqual([...view.container.querySelectorAll('[data-activity-tool]')].map(row => [row.getAttribute('data-activity-tool'), row.querySelector('[data-slot="collapsible-trigger"], button')?.textContent]),
      [['done', 'Create taskDone'], ['running', 'Start threadRunning'], ['error', 'Use a toolFailed']])
    assert.doesNotMatch(text(), /some_internal_tool|Fix login/, 'previews start closed')
    await act(async () => { (view.container.querySelector('[data-activity-tool="done"] button') as HTMLButtonElement).click() })
    for (let tries = 0; tries < 100 && !/i1/.test(text()); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    assert.match(text(), /Input[\s\S]*Fix login[\s\S]*Result[\s\S]*i1/)
    const thinkingTrigger = view.container.querySelector('[data-activity-thinking] button') as HTMLButtonElement
    assert.ok(thinkingTrigger.disabled, 'reasoning text is never shown, so thinking does not open')

    await view.render(<ReplyActivity tools={[]} thinking={{ active: false, seconds: 3 }} />)
    assert.equal(text(), 'Thought for 3 seconds')
    await view.render(<ReplyActivity tools={[]} thought />)
    assert.equal(text(), 'Thought', 'a stored reply knows only that it thought')
    await view.render(<ReplyActivity tools={[]} />)
    assert.equal(view.container.innerHTML, '')
  } finally { await view.unmount() }
})

test('readable reasoning opens under 「思考了 N 秒」, live and stored alike; without it the line does not open', async () => {
  const { ReplyActivity } = await import('../components/coordinator/reply-activity')
  const view = await mount()
  const trigger = () => view.container.querySelector('[data-activity-thinking] button') as HTMLButtonElement
  const content = () => view.container.querySelector('[data-activity-thinking] [data-slot="collapsible-content"]')?.textContent ?? ''
  const settle = async (done: () => boolean) => { for (let tries = 0; tries < 100 && !done(); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20))) }
  try {
    // Live, with what the model thought: AI Elements' trigger with its chevron, closed until opened.
    await view.render(<ReplyActivity tools={[]} thinking={{ active: false, seconds: 4, text: 'Check the login redirect first.' }} />)
    assert.equal(view.container.querySelector('[data-activity-thinking]')?.getAttribute('data-reasoning'), 'readable')
    assert.equal(trigger().disabled, false)
    assert.ok(trigger().querySelector('svg.lucide-chevron-down'), 'it shows the chevron')
    assert.doesNotMatch(content(), /login redirect/, 'closed by default')
    await act(async () => { trigger().click() })
    await settle(() => /login redirect/.test(content()))
    assert.match(content(), /Check the login redirect first\./)
    assert.equal(reasoningCalls.length, 0, 'live text needs no request')
    await view.unmount()

    // Stored: the same line opens and reads the same text, fetched only when opened.
    const stored = await mount()
    await stored.render(<ReplyActivity tools={[]} thought reasoningAt={[7, 9]} botId="bot-1" />)
    const storedTrigger = stored.container.querySelector('[data-activity-thinking] button') as HTMLButtonElement
    assert.equal(storedTrigger.disabled, false)
    assert.equal(reasoningCalls.length, 0, 'nothing is fetched until it is opened')
    await act(async () => { storedTrigger.click() })
    for (let tries = 0; tries < 100 && !/login redirect/.test(stored.container.textContent ?? ''); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    assert.match(stored.container.querySelector('[data-slot="collapsible-content"]')?.textContent ?? '', /Check the login redirect first\./, 'stored reads as live did')
    assert.deepEqual(reasoningCalls, [['bot-1', [7, 9]]])
    await stored.unmount()

    // Encrypted or no reasoning text, live or stored: the line only, no chevron, and it does not open.
    for (const props of [{ thinking: { active: false, seconds: 2 } }, { thought: true }]) {
      const plain = await mount()
      await plain.render(<ReplyActivity tools={[]} {...props} />)
      const button = plain.container.querySelector('[data-activity-thinking] button') as HTMLButtonElement
      assert.equal(plain.container.querySelector('[data-activity-thinking]')?.getAttribute('data-reasoning'), 'none')
      assert.ok(button.disabled)
      assert.equal(button.querySelector('svg.lucide-chevron-down'), null, 'no chevron')
      assert.equal(plain.container.querySelector('[data-slot="collapsible-content"]'), null)
      await plain.unmount()
    }
  } finally { try { await view.unmount() } catch { /* already unmounted */ } }
})
