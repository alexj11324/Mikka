import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKSPACE_SELECTION_HEADER } from '../workspace-selection'
import { pinnedWorkspaceSelection, withWorkspaceSelection } from './workspace-pin'

const alpha = '16610000-0000-4000-8000-00000000000a', beta = '16610000-0000-4000-8000-00000000000b'
const sent: Headers[] = []
Object.assign(globalThis, { window: { location: { pathname: '/mikka/zh-CN' } } })
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  sent.push(new Headers(init?.headers))
  return Response.json({ version: 1, ok: true, result: null })
}) as typeof fetch

test('only an action call started inside the scope carries the pinned Workspace header', async () => {
  const { callRemoteAction } = await import('../../apps/desktop/src/renderer/rpc')
  const transport = { endpoint: '/api/rpc', credentials: 'same-origin', header: 'x-mikka-rpc', locale: 'en' } as const
  sent.length = 0
  const pinned = withWorkspaceSelection(alpha.toUpperCase(), () => callRemoteAction('coordinator.sendCoordinatorMessage', [], transport))
  assert.equal(pinnedWorkspaceSelection(), null, 'the scope ends with the synchronous call')
  // A selection made after the call started (another tab, a switch) cannot reach the request already being built.
  const later = withWorkspaceSelection(beta, () => null)
  const unpinned = callRemoteAction('issues.listIssues', [], transport)
  await Promise.all([pinned, unpinned])
  assert.equal(later, null)
  assert.equal(sent[0].get(WORKSPACE_SELECTION_HEADER), alpha, 'normalized through the header contract')
  assert.equal(sent[1].has(WORKSPACE_SELECTION_HEADER), false)
})

test('an invalid id is refused before any request', () => {
  assert.throws(() => withWorkspaceSelection('not-a-uuid', () => assert.fail('no call')), /workspace_selection_invalid/)
})
