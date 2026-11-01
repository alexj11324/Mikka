import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

// Board copy is not under test here: every string reads as its key.
const translate = Object.assign((key: string, args?: { status?: string }) => args?.status ? `${key}:${args.status}` : key, { has: () => false })
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useFormatter: () => ({ dateTime: () => '' }), useNow: () => new Date(0) } })

let KanbanBoard: typeof import('./kanban-board')['KanbanBoard']
before(async () => { ({ KanbanBoard } = await import('./kanban-board')) })

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
