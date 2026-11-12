import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'
import type { DirectoryTeam, TeamDirectoryState } from './use-team-directory'

const current = 'workspace'
const chosen = { id: 'team', workspaceId: current, name: 'Invoices' } as DirectoryTeam
const other = { ...chosen, id: 'other', name: 'Another team' }
const actions: string[] = []
const reads = new Map<string, (value: object) => void>()
let finish: (value: object) => void = () => {}
const result = (id: string, canDelete: boolean) => ({ teamId: id, tasks: canDelete ? 0 : 1, canDelete })
mock.module('posthog-js', { defaultExport: { capture() {} } })
mock.module('next-intl', { namedExports: { useTranslations: () => (id: string) => id } })
mock.module('next/navigation', { namedExports: { useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {} }) } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => (message: string) => message } })
mock.module('@/lib/settings-navigation', { namedExports: { pushSettingsHistory: () => true } })
mock.module('@/components/workspace/workspace-navigation', { namedExports: { workspaceLink: () => '/' } })
mock.module('swr', { defaultExport: () => ({
  data: { workspace: { id: current }, currentUserId: 'owner', teams: [chosen, other] }, mutate: async () => {},
}), namedExports: { useSWRConfig: () => ({ mutate: async () => {} }) } })
mock.module('@/lib/settings-data', { namedExports: {
  fetchTeamDirectory() {}, fetchTeamMembers() {}, isSettingsAccessError() { return false }, settingsReadOptions: {},
  teamDirectoryKey(id: string) { return id }, teamMembersKey(id: string) { return id },
} })
mock.module('@/app/actions/teams', { namedExports: {
  getTeamDeletionImpact: (id: string) => new Promise(resolve => reads.set(id, resolve)),
  deleteTeam: (id: string, name: string) => { actions.push('delete ' + id + ' ' + name); return Promise.resolve({}) },
  removeTeamGrouping: (id: string, name: string) => { actions.push('ungroup ' + id + ' ' + name); return new Promise(resolve => { finish = resolve }) },
  saveTeam() {}, loadTeamDirectory() {}, changeTeamMember() {},
} })

test('strict deletion and explicit ungroup use separate intents, impact receipts and writers', async () => {
  const window = new Window()
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const { useTeamDirectory } = await import('./use-team-directory')
  const root = createRoot(window.document.createElement('main') as unknown as HTMLElement)
  let directory: TeamDirectoryState
  function Directory() { directory = useTeamDirectory(current); return null }
  try {
    await act(async () => root.render(createElement(Directory)))
    await act(async () => { void directory.askDelete(chosen); void directory.askRemoveGrouping(other) })
    await act(async () => { reads.get(other.id)!(result(other.id, false)); reads.get(chosen.id)!(result(chosen.id, true)) })
    assert.equal(directory!.deletion?.team.id, other.id)
    await act(async () => { await directory.confirmDelete(other.name); await directory.confirmRemoveGrouping('wrong') })
    assert.deepEqual(actions, [])
    await act(async () => { void directory.confirmRemoveGrouping(other.name); void directory.confirmRemoveGrouping(other.name) })
    assert.deepEqual(actions, ['ungroup other Another team'])
    await act(async () => finish({ error: 'workspaceAccessDenied' }))
    assert.equal(directory!.error, 'workspaceAccessDenied')
    assert.equal(directory!.deletion?.intent, 'ungroup')
    await act(async () => { void directory.confirmRemoveGrouping(other.name); finish({ removed: { teamId: other.id } }) })
    assert.equal(directory!.deletion, null)
    await act(async () => { void directory.askDelete(chosen); reads.get(chosen.id)!(result(chosen.id, false)) })
    await act(async () => { await directory.confirmDelete(chosen.name); await directory.confirmRemoveGrouping(chosen.name) })
    assert.deepEqual(actions, ['ungroup other Another team', 'ungroup other Another team'])
    await act(async () => { void directory.askDelete(chosen); reads.get(chosen.id)!(result(chosen.id, true)) })
    await act(async () => { await directory.confirmDelete(chosen.name) })
    assert.equal(actions.at(-1), 'delete team Invoices')
    assert.equal(directory!.deletion, null)
  } finally {
    await act(async () => root.unmount())
    await window.close()
  }
})
