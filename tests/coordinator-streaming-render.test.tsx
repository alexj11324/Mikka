import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en.json'
import { withoutPartialCitation, type CitationSource } from '../lib/coordinator/citations'
import type { AgentCitations } from '../components/workspace/agent-citations'
import { ReplyBubbles } from '../components/workspace/agent-text-bubble'
import { AgentInteractionContext } from '../components/workspace/agent-interaction'

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

test('a reply draws its thinking and its tools as shadcn Trace rows: several calls are one summary line that opens to a row each (R-83)', async () => {
  const { ReplyActivity, ReplyWaiting } = await import('../components/coordinator/reply-activity')
  const view = await mount()
  const text = () => view.container.textContent ?? ''
  const rows = () => [...view.container.querySelectorAll('[data-activity-tool]')].map(row => [row.getAttribute('data-activity-tool'), row.querySelector('[data-slot="trace-title"]')?.textContent, row.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status') ?? null])
  const group = () => view.container.querySelector('[data-activity-group]')
  const settle = async (done: () => boolean) => { for (let tries = 0; tries < 100 && !done(); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20))) }
  try {
    const tools = [
      { call: 'c1', name: 'create_issue', state: 'done' as const, input: '{"title":"Fix login"}', output: '{"id":"i1"}' },
      { call: 'c2', name: 'dispatch_run', state: 'running' as const },
      { call: 'c3', name: 'dispatch_factory_task', state: 'done' as const, output: '{"error":"factoryNotFound"}' },
    ]
    // Live: thinking runs and is open as its words stream in; the group is open on the call running now.
    await view.render(<ReplyActivity live tools={tools} thinking={{ active: true, seconds: 1, text: 'Check the login' }} />)
    const thinking = view.container.querySelector('[data-activity-thinking]')
    assert.equal(thinking?.getAttribute('data-activity-thinking'), 'active')
    assert.equal(thinking?.querySelector('[data-slot="trace-title"]')?.textContent, 'Thinking')
    assert.equal(thinking?.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status'), 'running')
    assert.ok(thinking?.querySelector('svg.lucide-loader-circle.animate-spin'), 'a spinner while it thinks')
    await settle(() => /Check the login/.test(text()))
    assert.match(text(), /Check the login/, 'the running row is open, so its words show as they stream')
    assert.equal(group()?.getAttribute('data-activity-group'), 'running')
    await settle(() => rows().length === 3)
    assert.deepEqual(rows(), [['done', 'Create taskFix login', null], ['running', 'Start task', 'running'], ['error', 'Dispatch Factory task· Factory task not found', 'error']],
      'verb and object; an answered error is a failure with its reason')
    assert.doesNotMatch(text(), /dispatch_factory_task|i1|factoryNotFound/, 'raw input and output start closed')
    // Opened, a call says what it did in words first; its raw data is one more click away, under 「Raw data」.
    const click = (selector: string) => act(async () => { (view.container.querySelector(selector) as HTMLButtonElement).click() })
    await click('[data-activity-tool="done"] button')
    await settle(() => Boolean(view.container.querySelector('[data-activity-tool="done"] [data-activity-detail]')))
    assert.equal(view.container.querySelector('[data-activity-tool="done"] [data-activity-detail]')?.textContent, 'TitleFix login')
    assert.doesNotMatch(text(), /i1/, 'the raw output starts folded')
    await click('[data-activity-tool="done"] [data-activity-raw] button')
    await settle(() => /i1/.test(text()))
    assert.equal(view.container.querySelectorAll('[data-activity-tool="done"] [data-slot="code-block"]')[1]?.textContent, '{"id":"i1"}', 'the output in a code block, after the input')
    await click('[data-activity-tool="error"] button')
    await click('[data-activity-tool="error"] [data-activity-raw] button')
    await settle(() => /factoryNotFound/.test(text()))
    assert.equal(view.container.querySelector('[data-activity-tool="error"] [data-slot="code-block"]')?.getAttribute('data-variant'), 'destructive')

    // Stored: one summary line, closed, side effects first, with how many failed; a call that never returned failed too.
    await view.render(<ReplyActivity tools={[tools[2], { ...tools[2], call: 'c9' }]} />)
    assert.equal(group()?.querySelector('[data-slot="trace-title"]')?.textContent, 'Dispatch Factory task', 'nothing succeeded: the line names the failed call')
    await view.render(<ReplyActivity tools={[...tools, { call: 'c5', name: 'get_issue', state: 'done' as const }]} />)
    assert.equal(group()?.getAttribute('data-activity-group'), 'error')
    assert.ok(group()?.querySelector('svg.lucide-circle-alert'), 'a failure is an icon, a colour and a word together (R-87)')
    // Only what succeeded is said as done: the dispatch that never returned and the Factory call that answered an error
    // are only in the failure count, never 「Dispatched」 (R-83).
    assert.equal(group()?.querySelector('[data-slot="trace-title"]')?.textContent, 'Created 1 task · Looked up tasks')
    assert.equal(group()?.querySelector('[data-activity-failed]')?.textContent, '2 failed', 'the failure count sits outside the summary, so it never truncates')
    // Stored, a tool that never returned failed: the docs' row for a call that is not streaming.
    await view.render(<ReplyActivity tools={[tools[1]]} />)
    assert.deepEqual(rows(), [['error', 'Start task', 'error']])
    // A tool with nothing to show is a line that does not open.
    await view.render(<ReplyActivity tools={[{ call: 'c4', name: 'create_issue', state: 'done' }]} />)
    assert.equal(view.container.querySelector('[data-activity-tool] button'), null)

    await view.render(<ReplyActivity tools={[]} thinking={{ active: false, seconds: 3 }} />)
    assert.equal(view.container.querySelector('[data-activity-thinking]')?.getAttribute('data-activity-thinking'), 'done')
    assert.equal(text(), 'Thought for 3 seconds')
    assert.ok(view.container.querySelector('[data-activity-thinking] svg.lucide-circle-check'), 'a check once it stops')
    await view.render(<ReplyActivity tools={[]} thought />)
    assert.equal(text(), 'Thought', 'a stored reply knows only that it thought')
    await view.render(<ReplyActivity tools={[]} />)
    assert.equal(view.container.innerHTML, '')
    // Before the reply has anything: the same Thinking row, running.
    await view.render(<ReplyWaiting />)
    assert.equal(text(), 'Thinking')
    assert.equal(view.container.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status'), 'running')
  } finally { await view.unmount() }
})

test('readable reasoning opens under 「思考了 N 秒」, live and stored alike; without it the line does not open', async () => {
  const { ReplyActivity } = await import('../components/coordinator/reply-activity')
  const view = await mount()
  const trigger = () => view.container.querySelector('[data-activity-thinking] button') as HTMLButtonElement
  const content = () => view.container.querySelector('[data-activity-thinking] [data-slot="trace-collapsible-content"]')?.textContent ?? ''
  const settle = async (done: () => boolean) => { for (let tries = 0; tries < 100 && !done(); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20))) }
  try {
    // Live, finished, with what the model thought: the Trace row's trigger with its chevron, closed until opened.
    await view.render(<ReplyActivity tools={[]} thinking={{ active: false, seconds: 4, text: 'Check the login redirect first.' }} />)
    assert.equal(view.container.querySelector('[data-activity-thinking]')?.getAttribute('data-reasoning'), 'readable')
    assert.ok(trigger().querySelector('svg.lucide-chevron-right'), 'it shows the chevron')
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
    assert.ok(storedTrigger)
    assert.equal(reasoningCalls.length, 0, 'nothing is fetched until it is opened')
    await act(async () => { storedTrigger.click() })
    for (let tries = 0; tries < 100 && !/login redirect/.test(stored.container.textContent ?? ''); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20)))
    assert.match(stored.container.querySelector('[data-slot="trace-collapsible-content"]')?.textContent ?? '', /Check the login redirect first\./, 'stored reads as live did')
    assert.deepEqual(reasoningCalls, [['bot-1', [7, 9]]])
    await stored.unmount()

    // Encrypted or no reasoning text, live or stored: the line only, no chevron, and it does not open.
    for (const props of [{ thinking: { active: false, seconds: 2 } }, { thought: true }]) {
      const plain = await mount()
      await plain.render(<ReplyActivity tools={[]} {...props} />)
      assert.equal(plain.container.querySelector('[data-activity-thinking]')?.getAttribute('data-reasoning'), 'none')
      assert.equal(plain.container.querySelector('[data-activity-thinking] button'), null, 'no trigger')
      assert.equal(plain.container.querySelector('svg.lucide-chevron-right'), null, 'no chevron')
      assert.equal(plain.container.querySelector('[data-slot="trace-collapsible-content"]'), null)
      await plain.unmount()
    }
  } finally { try { await view.unmount() } catch { /* already unmounted */ } }
})

test('an opened dispatch reads 「Handed to」 its coding agent and its thread chip, then the note as a quote; never ids, JSON or the task (R-83)', async () => {
  const { ReplyActivity } = await import('../components/coordinator/reply-activity')
  const { AgentCitationsContext } = await import('../components/workspace/agent-citations')
  const { jsonbText } = await import('../lib/coordinator/context')
  const view = await mount()
  const settle = async (done: () => boolean) => { for (let tries = 0; tries < 100 && !done(); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20))) }
  const open = async (selector = '[data-activity-tool] button') => {
    await act(async () => { (view.container.querySelector(selector) as HTMLButtonElement).click() })
    await settle(() => Boolean(view.container.querySelector('[data-activity-detail]')))
  }
  // A long note, in jsonb's key order and cut at 200 characters as the chat gets it: the note comes first and is cut.
  const note = 'Reproduce the redirect loop on sign-in with a fresh account, check the callback URL the provider sends back against the one we register, fix the mismatch, add a regression test for it, and open a PR.'
  const input = jsonbText({ issueId: TASK, botId: '3c3aa707-0000-4c22-b322-0000000000d4', note }).slice(0, 200)
  const dispatch = { call: 'd1', name: 'dispatch_run', state: 'done' as const, input, quote: note, output: jsonbText({ runId: THREAD, status: 'queued' }) }
  const citations = { ...base, sources: { ...known, [THREAD]: thread } }
  try {
    await view.render(<AgentCitationsContext value={citations}><ReplyActivity tools={[dispatch]} /></AgentCitationsContext>)
    await open()
    const detail = () => view.container.querySelector('[data-activity-detail]')
    assert.match(detail()?.textContent ?? '', /^Handed toClaude Code/, 'who it went to first: the coding agent, never the bot')
    const chip = detail()?.querySelector('[data-activity-thread] [data-slot="inline-citation-trigger"]')
    assert.match(chip?.textContent ?? '', /Fix sign-in redirect/, 'the thread as its chip')
    assert.equal(detail()?.querySelectorAll('[data-slot="inline-citation-trigger"]').length, 1, 'one chip: the thread; the task is not drawn (R-15)')
    assert.equal(detail()?.querySelectorAll('[data-slot="badge"]').length, 0, 'no second state badge beside the chip')
    const quote = detail()?.querySelector('[data-activity-quote]')
    assert.equal(quote?.textContent, note, 'the whole note, from the call\'s own quote, though the input preview cut it')
    assert.match(quote?.querySelector('span')?.className ?? '', /line-clamp-3/)
    const shown = view.container.textContent ?? ''
    assert.doesNotMatch(shown, /"runId"|\{/, 'no raw JSON until 「Raw data」 is opened')
    assert.doesNotMatch(shown, MARKUP, 'no ids')
    assert.ok(view.container.querySelector('[data-activity-raw]'), 'the raw data is there, folded')

    // A thread the chat has not loaded: who it went to and its state in words, as the thread list groups it (R-52).
    await view.render(<AgentCitationsContext value={{ ...base, sources: known }}><ReplyActivity key="unloaded" tools={[{ ...dispatch, output: jsonbText({ runId: THREAD, status: 'queued', harness: 'codex' }) }]} /></AgentCitationsContext>)
    await open()
    assert.equal(detail()?.querySelector('[data-activity-thread]')?.textContent, 'Handed toCodex· Running')

    // A failed call says nothing in words and draws no quote: its row names the reason.
    const failed = { call: 'm1', name: 'send_email', state: 'done' as const, input: jsonbText({ to: 'a@example.com', subject: 'Hi', body: 'Hello there' }), output: '{"error": "forbidden"}' }
    await view.render(<AgentCitationsContext value={citations}><ReplyActivity key="failed" tools={[failed]} /></AgentCitationsContext>)
    await act(async () => { (view.container.querySelector('[data-activity-tool="error"] button') as HTMLButtonElement).click() })
    await settle(() => Boolean(view.container.querySelector('[data-activity-raw]')))
    assert.equal(view.container.querySelector('[data-activity-detail]'), null)
    assert.doesNotMatch(view.container.querySelector('[data-activity-tool="error"]')?.textContent ?? '', /a@example\.com|Hello there|error: forbidden/)

    // A raw SDK failure is never the row's words: one line in the reader's language, the text only under 原始数据 (#1516).
    const raw = "AI_NoSuchToolError: Model tried to call unavailable tool 'none'. Available tools: get_issue."
    await view.render(<AgentCitationsContext value={citations}><ReplyActivity key="unknown" tools={[{ call: 'u1', name: 'none', state: 'error' as const, input: '{}', output: raw }]} /></AgentCitationsContext>)
    const unknownTitle = () => view.container.querySelector('[data-activity-tool="error"] [data-slot="trace-title"]')?.textContent
    assert.equal(unknownTitle(), 'Unknown step· failed, skipped')
    await act(async () => { (view.container.querySelector('[data-activity-tool="error"] button') as HTMLButtonElement).click() })
    await settle(() => Boolean(view.container.querySelector('[data-activity-raw]')))
    await act(async () => { (view.container.querySelector('[data-activity-raw] button') as HTMLButtonElement).click() })
    await settle(() => Boolean(view.container.querySelector('[data-activity-raw] [data-slot="code-block"]')))
    assert.match(view.container.querySelector('[data-activity-raw]')?.textContent ?? '', /AI_NoSuchToolError/)

    // Inside a group, an opened row reads the same.
    await view.render(<AgentCitationsContext value={citations}><ReplyActivity key="group" tools={[{ call: 'g1', name: 'get_issue', state: 'done' as const, input: '{"identifier": "MIK-1"}' }, dispatch]} /></AgentCitationsContext>)
    await act(async () => { (view.container.querySelector('[data-activity-group] button') as HTMLButtonElement).click() })
    await settle(() => view.container.querySelectorAll('[data-activity-tool]').length === 2)
    await open('[data-activity-tool]:nth-child(2) button')
    assert.match(detail()?.textContent ?? '', /^Handed toClaude Code/)
    assert.equal(detail()?.querySelector('[data-activity-quote]')?.textContent, note)
  } finally { await view.unmount() }
})

test('a quote cut at three lines is a button that opens the rest; one that fits is plain text (R-83)', async () => {
  const { ReplyActivity } = await import('../components/coordinator/reply-activity')
  const view = await mount()
  const proto = browser.HTMLElement.prototype as unknown as object
  const stub = (height: number) => {
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return height } })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 60 } })
  }
  const settle = async (done: () => boolean) => { for (let tries = 0; tries < 100 && !done(); tries++) await act(() => new Promise(resolve => setTimeout(resolve, 20))) }
  const quote = () => view.container.querySelector('[data-activity-quote]')
  const tool = { call: 'q1', name: 'dispatch_run', state: 'done' as const, input: '{"note": "Long"}', quote: 'A long note. '.repeat(40).trim() }
  try {
    stub(200)
    await view.render(<ReplyActivity tools={[tool]} />)
    await act(async () => { (view.container.querySelector('[data-activity-tool] button') as HTMLButtonElement).click() })
    await settle(() => quote()?.tagName === 'BUTTON')
    assert.equal(quote()?.tagName, 'BUTTON', 'cut: a button')
    assert.equal(quote()?.getAttribute('aria-expanded'), 'false')
    await act(async () => { (quote() as HTMLButtonElement).click() })
    assert.equal(quote()?.getAttribute('aria-expanded'), 'true')
    assert.doesNotMatch(quote()?.querySelector('span')?.className ?? '', /line-clamp-3/, 'opened, the whole note')
    stub(60)
    await view.render(<ReplyActivity key="fits" tools={[{ ...tool, call: 'q2', quote: 'Short.' }]} />)
    await act(async () => { (view.container.querySelector('[data-activity-tool] button') as HTMLButtonElement).click() })
    await settle(() => Boolean(quote()))
    assert.equal(quote()?.tagName, 'DIV', 'fits: plain text, nothing to open')
    assert.equal(quote()?.hasAttribute('aria-expanded'), false)
  } finally {
    delete (proto as Record<string, unknown>).scrollHeight
    delete (proto as Record<string, unknown>).clientHeight
    await view.unmount()
  }
})

test('a task and its thread in one reply: the task is its state icon and code, the thread its title, said once (2026-11-10)', async () => {
  const view = await mount()
  const chips = () => [...view.container.querySelectorAll('[data-slot="inline-citation-trigger"]')]
  const text = () => view.container.textContent ?? ''
  const ownThread: CitationSource = { ...thread, issue: { id: TASK, number: 1, identifier: 'MIK-1', title: 'Release checklist' } }
  try {
    await view.render(<CoordinatorReply text={`[[issue:${TASK}]] 的线程 [[run:${THREAD}]] 在等你。`} citations={{ ...base, sources: { ...known, [THREAD]: ownThread } }} />)
    assert.equal(chips().length, 2, 'the task and the thread each stay their own object')
    assert.equal(text(), 'MIK-1 的线程 Release checklist 在等你。', 'the code once, the title once: never 「MIK-1 MIK-1 …」')
    assert.equal(view.container.querySelector('[data-citation-covered]'), null)
    assert.ok(chips()[0].querySelector('[data-task-state]'), 'the task leads with its state icon')
    assert.equal(chips()[1].querySelector('svg'), null, 'the thread has no icon')
    // A task with no code is its title; the thread still names its task's title.
    const unnumbered = { [TASK]: { ...issue(TASK, 'Release checklist'), identifier: null }, [THREAD]: ownThread }
    await view.render(<CoordinatorReply text={`[[issue:${TASK}]]的线程 [[run:${THREAD}]] 在等你。`} citations={{ ...base, sources: unnumbered }} />)
    assert.equal(chips().length, 2)
    assert.equal(text(), 'Release checklist的线程 Release checklist 在等你。')
    assert.doesNotMatch(text(), MARKUP)
  } finally { await view.unmount() }
})

test('a thread keeps its current text-link renderer when a dispatch card sits under the same saved reply', async () => {
  const view = await mount()
  try {
    const citations = { ...base, sources: { ...known, [THREAD]: thread } }
    await view.render(<CoordinatorReply text={`已派出线程 [[run:${THREAD}]]。`} citations={citations} carded={THREAD} />)
    assert.equal(view.container.querySelectorAll('[data-thread-link]').length, 1)
    assert.equal(view.container.querySelector('[data-thread-link]')?.textContent, 'Fix sign-in redirect')
    assert.equal(view.container.querySelector('[data-citation-carded]'), null)
    // A thread of a task is named by the task's title, without its code.
    await view.render(<CoordinatorReply text={`已派出线程 [[run:${THREAD}]]。`} citations={{ ...citations, sources: { ...known, [THREAD]: { ...thread, issue: { id: TASK, number: 1, identifier: 'MIK-1', title: 'Release checklist' } } } }} carded={THREAD} />)
    assert.equal(view.container.querySelector('[data-thread-link]')?.textContent, 'Release checklist')
    await view.render(<CoordinatorReply text={`已派出线程 [[run:${THREAD}]]。`} citations={citations} />)
    assert.equal(view.container.querySelectorAll('[data-thread-link]').length, 1, 'with or without a card it is the same thread link')
  } finally { await view.unmount() }
})

test('全部展开 opens every tool group, a group clicked alone keeps its own state, 全部收起 closes them all (R-83)', async () => {
  const { ActivityExpansionContext, ReplyActivity, useActivityExpansion } = await import('../components/coordinator/reply-activity')
  const view = await mount()
  const tools = (n: string) => [{ call: `${n}1`, name: 'get_issue', state: 'done' as const }, { call: `${n}2`, name: 'list_runs', state: 'done' as const }]
  function Chat() {
    const expansion = useActivityExpansion()
    return <ActivityExpansionContext value={expansion}><ReplyActivity tools={tools('a')} /><ReplyActivity tools={tools('b')} /></ActivityExpansionContext>
  }
  const groups = () => [...view.container.querySelectorAll('[data-activity-group]')]
  const opened = () => groups().map(group => group.querySelector('[data-slot="trace-collapsible-trigger"]')?.getAttribute('aria-expanded'))
  const expandAll = () => view.container.querySelector('[data-activity-expand-all]') as HTMLButtonElement
  try {
    await view.render(<Chat />)
    assert.deepEqual(opened(), ['false', 'false'], 'closed by default')
    assert.equal(view.container.querySelectorAll('[data-activity-expand-all]').length, 2, 'the control is on every group, always shown')
    await act(async () => { expandAll().click() })
    assert.deepEqual(opened(), ['true', 'true'])
    await act(async () => { (groups()[0].querySelector('[data-slot="trace-collapsible-trigger"]') as HTMLButtonElement).click() })
    assert.deepEqual(opened(), ['false', 'true'], 'the reader\'s own click wins for that group')
    await act(async () => { expandAll().click() })
    assert.deepEqual(opened(), ['false', 'false'], '全部收起 closes every group, the one set alone included')
  } finally { await view.unmount() }
})

test('a reply draws its words in bubbles on its own, and plain in a frame that sets ReplyBubbles off (hosted thread): Markdown, OpenUI text and a choice card agree (2026-11-10)', async () => {
  const welcome = 'root = Stack([intro, choice])\nintro = TextContent("I can dispatch work to Agents.")\nchoice = BeQuestions("New bot", [{id:"next", title:"What first?", options:[{value:"task", label:"Create a task"}, {value:"list", label:"See running tasks"}]}])'
  const sent: string[] = []
  const interaction = { busy: false, continueFromAnswer: async (prompt: string) => { sent.push(prompt); return true } }
  const view = await mount()
  try {
    // On its own (the open-source chat): every text part in the grey bubble, the question in the reply's bubble.
    await view.render(<AgentInteractionContext value={interaction}><CoordinatorReply text={welcome} citations={base} /></AgentInteractionContext>)
    assert.equal(view.container.querySelectorAll('[data-agent-text]').length, 1)
    assert.match(view.container.querySelector('[data-choice-title]')?.className ?? '', /bg-muted/)
    // Inside a frame that draws reply text plain: nothing is bubbled, Markdown included.
    for (const text of [welcome, 'Plain **Markdown** reply.']) {
      await view.render(<AgentInteractionContext value={interaction}><ReplyBubbles value={false}><CoordinatorReply text={text} citations={base} /></ReplyBubbles></AgentInteractionContext>)
      assert.equal(view.container.querySelectorAll('[data-agent-text]').length, 0, text)
    }
    await view.render(<AgentInteractionContext value={interaction}><ReplyBubbles value={false}><CoordinatorReply text={welcome} citations={base} /></ReplyBubbles></AgentInteractionContext>)
    assert.doesNotMatch(view.container.querySelector('[data-choice-title]')?.className ?? '', /bg-muted/, 'the question is not a pill')
    // The options are rows that answer with their words.
    const rows = [...view.container.querySelectorAll<HTMLButtonElement>('[data-choice-rows] button[data-choice="open"]')]
    assert.deepEqual(rows.map(row => row.textContent), ['ACreate a task', 'BSee running tasks'])
    assert.ok(rows.every(row => !row.disabled))
    await act(async () => { rows[1].click() })
    assert.deepEqual(sent, ['See running tasks'])
  } finally { await view.unmount() }
})
