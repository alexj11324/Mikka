import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'
import { SWRConfig, useSWRConfig } from 'swr'

const win = new Window({ url: 'https://project.example/mikka' })
const rows = {
  teams: [{ id: 'team', name: 'Design' }],
  'project-teams': [{ teamId: 'team', projectId: 'project', isPrimary: true }],
}
let denied, mutate
const reads = []
async function read(key) {
  reads.push(key)
  if (denied === key) throw new Error('read unavailable')
  return rows[key]
}
mock.module('../app/actions/teams.ts', { namedExports: { listTeams: () => read('teams') } })
mock.module('../app/actions/team-relations.ts', { namedExports: {
  listProjectTeams: () => read('project-teams'), setProjectTeams: () => assert.fail('A read retry must never write'),
} })
mock.module('next-intl', { namedExports: { useTranslations: () => key => key } })
function Cache() {
  mutate = useSWRConfig().mutate
  return null
}
let createRoot, ProjectTeamControl
before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'Node']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? win : win[key] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ProjectTeamControl } = await import('../components/teams/project-team-control.tsx'))
})
after(() => win.happyDOM.abort())
test('failed project team reads withdraw cached badges and Retry restores the current associations', async () => {
  for (const key of ['teams', 'project-teams']) {
    const host = document.body.appendChild(document.createElement('main'))
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(SWRConfig, { value: {
        provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0,
      } }, createElement(Cache), createElement(ProjectTeamControl, {
        project: { id: 'project', canEditProperties: true }, onUpdated() {}, disabled: false,
      }))))
      assert.match(host.textContent, /Design/)
      denied = key
      await act(async () => { await mutate(key) })
      assert.doesNotMatch(host.textContent, /Design|FeatureCopy.c_46147716/)
      assert.ok(host.querySelector('[role="alert"]'))
      const retry = [...host.querySelectorAll('button')].find(b => b.textContent === 'Common.retry')
      assert.ok(retry)
      denied = undefined
      reads.length = 0
      await act(async () => retry.click())
      assert.deepEqual(reads, [key])
      assert.match(host.textContent, /Design/)
      assert.equal(host.querySelector('[role="alert"]'), null)
    } finally {
      denied = undefined
      await act(async () => root.unmount())
      host.remove()
    }
  }
})
