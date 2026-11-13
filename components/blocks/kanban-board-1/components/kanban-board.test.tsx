import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'
import type { BoardTask } from './data'

// Board copy is not under test here: every string reads as its key.
const translate = Object.assign((key: string, args?: { status?: string }) => args?.status ? `${key}:${args.status}` : key, { has: () => false })
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useFormatter: () => ({ dateTime: () => '' }), useNow: () => new Date(0) } })

mock.module('@/components/workspace/issue-metadata-controls', { namedExports: { IssueMetadataControls: () => null, LabelDot: () => null } })
let TaskContextMenu: typeof import('./kanban-board')['TaskContextMenu']
let KanbanBoard: typeof import('./kanban-board')['KanbanBoard']
before(async () => { ({ KanbanBoard, TaskContextMenu } = await import('./kanban-board')) })

const COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done'] as const
const noop = () => {}
function render(sidebarOpen: boolean) {
  return renderToStaticMarkup(<KanbanBoard
    value={Object.fromEntries(COLUMNS.map(status => [status, []]))} onValueChange={noop}
    columns={[...COLUMNS]} hiddenColumns={[{ status: 'canceled', count: 2 }]} sidebarOpen={sidebarOpen}
    context={{ properties: new Set(), agentStates: new Map(), subtasks: new Map(), owners: new Map() } as never}
    viewportRef={null} viewportId="board" instructionsId="board-help" onViewportKeyDown={noop}
    onHideColumn={noop} onShowColumn={noop} onOpen={noop} onStatusChange={noop} onPriorityChange={noop}
    onMetadataSaved={noop} onMetadataBusy={noop} onDelete={noop} onDiscuss={noop} />)
}
/** The class list of every column the board draws, in order. */
function columnClasses(html: string) {
  return [...html.matchAll(/<div[^>]*data-slot="kanban-column"[^>]*>/g)].map(([tag]) => tag.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? [])
}

// R-25 (decisions/2026-11-01-1144-board-done-keeps-its-width.md): beside the Coordinator sidebar
// 已完成 used to fold to a 40px strip that read as a squeezed column next to the sidebar.
for (const sidebarOpen of [false, true]) test(`every column is a fixed 300px that never shrinks (sidebar ${sidebarOpen ? 'open' : 'closed'})`, () => {
  const html = render(sidebarOpen)
  const columns = columnClasses(html)
  assert.equal(columns.length, COLUMNS.length)
  for (const classes of columns) {
    for (const required of ['w-75', 'min-w-75', 'shrink-0']) assert.ok(classes.includes(required), `column lacks ${required}: ${classes.join(' ')}`)
    assert.ok(!classes.some(name => /^(min-)?w-(10|\d)$/.test(name)), `column folds to a strip: ${classes.join(' ')}`)
  }
  for (const status of COLUMNS) assert.ok(html.includes(`columnLabel:${status}`), `${status} draws a full column`)
  assert.ok(!html.includes('expandColumn'), 'no folded strip')
  // The track is as wide as its columns, so the board scrolls instead of squeezing them.
  assert.match(html, /data-slot="kanban-board"[^>]*class="[^"]*\bw-max\b/)
})

test('beside the sidebar the hidden lane is left out; without it the lane shows', () => {
  assert.ok(render(false).includes('aria-label="hiddenLane"'))
  assert.ok(!render(true).includes('aria-label="hiddenLane"'))
})

const browser = new Window({ url: 'https://fixture.example/' })
before(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  for (const key of ['document', 'Element', 'HTMLElement', 'Node'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: browser[key] })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
after(() => browser.happyDOM.close())

for (const Tag of ['article', 'div'] as const) test(`the official ${Tag === 'article' ? 'Board card' : 'list row'} is its own focus-return target`, async () => {
  const task = { id: 'task-42', status: 'todo', priority: 'normal', metadata: { labels: [], pullRequests: [] } } as unknown as BoardTask
  const open = mock.fn((_id: string) => {})
  const root = (await import('react-dom/client')).createRoot(document.body)
  try {
    await act(async () => root.render(<TaskContextMenu task={task} disabled={false} block={false}
      onStatusChange={noop} onPriorityChange={noop} onMetadataSaved={noop} onMetadataBusy={noop}
      onDelete={noop} onDiscuss={noop} onBlockChange={noop}>
      <Tag data-card={task.id} role="button" tabIndex={0} aria-label="My task" draggable={Tag === 'article'}
        onClick={() => open(task.id)} onKeyDown={event => { if (event.key === 'Enter') open(task.id) }}>My task</Tag>
    </TaskContextMenu>))
    const opener = document.querySelector<HTMLElement>(`[data-card="${task.id}"]`)
    assert.ok(opener)
    assert.equal(document.querySelector(`[data-focus-id="${task.id}"]`) === opener, true)
    assert.equal(opener.localName, Tag)
    assert.equal(opener.getAttribute('aria-label'), 'My task')
    assert.equal(opener.getAttribute('data-slot'), 'context-menu-trigger')
    assert.equal(document.querySelectorAll('[tabindex="0"]').length, 1)
    assert.equal(opener.getAttribute('draggable'), String(Tag === 'article'))
    opener.focus()
    assert.equal(document.activeElement === opener, true)
    await act(async () => { opener.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as KeyboardEvent) })
    assert.deepEqual(open.mock.calls.map(call => call.arguments), [[task.id]])
  } finally {
    await act(async () => root.unmount())
  }
})
