import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import React, { act } from 'react'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'
import type { TaskPresentation } from '@/lib/task-presentation'
import type { SearchPaletteProps } from '@/components/slots/search-contract'

const browser = new Window({ url: 'https://fixture.example' })
Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
after(() => browser.happyDOM.close())

const local = 'local'
const workspaceId = 'workspace'
const projection: TaskPresentation = { version: 1, state: 'waiting', reason: 'pr_review', blockedBy: null, group: 'pending',
  primaryStatus: 'doing', factoryStage: null, runStatus: null, needsAction: null, blockedReason: null, completion: null }
const remote = Array.from({ length: 201 }, (_, index) => ({ id: `remote-${index}`, type: 'task', title: 'Same', status: 'done', identifier: null }))
const pages: string[][] = []
const selected: string[] = []
let palette: SearchPaletteProps
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key, useLocale: () => 'en' } })
mock.module('@/hooks/use-live-key', { namedExports: { useLiveScope: () => ({ ownerId: 'owner', workspaceId }), useLiveKeys: () => {} } })
mock.module('@/app/actions/task-domain', { namedExports: { getTaskPresentations: async (input: { workspaceId: string; issueIds: string[] }) => {
  assert.equal(input.workspaceId, workspaceId)
  pages.push(input.issueIds)
  return { version: 1, workspaceId, items: Object.fromEntries(input.issueIds.filter(id => id !== 'remote-200').map(id => [id, projection])) }
} } })
mock.module('@/hooks/use-site-search', { namedExports: { useSiteSearch: () => {
  const empty = { items: [], status: 'ready' }
  return { query: { kind: 'ready' }, state: { groups: empty, history: empty, tasks: { items: [{ ...remote[0], id: local }, ...remote], status: 'ready' } }, sources: [], searching: false }
} } })
mock.module('@ui-slot/search', { namedExports: { SearchPalette: (props: SearchPaletteProps) => { palette = props; return null } } })
mock.module('./thread-list', { namedExports: { threadName: () => '', ThreadMark: () => null } })

test('local and remote Search hits use the same authorized task projection and preserve id-based navigation', async () => {
  const { createRoot } = await import('react-dom/client')
  const { GlobalSearch } = await import('./global-search')
  const { TaskPresentationsContext } = await import('@/hooks/use-task-collection')
  const root = createRoot(document.body)
  const issue = { id: local, title: 'Same', status: 'done', workspaceId, metadata: {}, identifier: null } as React.ComponentProps<typeof GlobalSearch>['issues'][number]
  const noop = () => {}
  try {
    await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <TaskPresentationsContext value={{ [local]: projection }}><GlobalSearch open onOpenChange={noop} workspaceId={workspaceId}
        bots={[]} sessions={[]} issues={[issue]} projects={[]} onChat={noop} onNewBot={noop} onIssue={id => { selected.push(id); return true }} onProject={noop} onCreateIssue={noop} /></TaskPresentationsContext>
    </SWRConfig>))
    const rows = palette.sections.find(section => section.id === 'tasks')!.rows
    assert.equal(rows.length, 202)
    assert.deepEqual(rows[0].status, { label: 'panel.task.reason.pr_review', tone: 'warning' })
    assert.deepEqual(rows[1].status, rows[0].status)
    assert.equal(rows.at(-1)?.status, undefined, 'a withheld row cannot fall back to an unverified board status')
    assert.deepEqual(pages.map(ids => ids.length), [200, 1])
    assert.ok(pages.flat().every(id => id !== local))
    rows[0].select(); rows[1].select()
    assert.deepEqual(selected, [local, 'remote-0'])
  } finally { await act(async () => root.unmount()) }
})
