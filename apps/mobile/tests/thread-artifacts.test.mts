import assert from 'node:assert/strict'
import test from 'node:test'
import { hasThreadArtifacts, shownGroups, threadArtifactsPath, type ThreadArtifacts } from '../features/tasks/model/thread-artifacts.ts'

const empty = (): ThreadArtifacts => ({ groups: { plans: [], pullRequests: [], reports: [], captures: [] }, count: 0 })

test('the 线程 | Artifact toggle shows only once the thread produced something', () => {
  assert.equal(hasThreadArtifacts(null), false)
  assert.equal(hasThreadArtifacts(empty()), false)
  const one = empty()
  one.groups.pullRequests.push({ group: 'pullRequests', id: 'pr', url: 'https://github.com/acme/app/pull/7', state: 'merged', title: 'Fix' })
  one.count = 1
  assert.equal(hasThreadArtifacts(one), true)
})

test('groups keep the web order 方案, PR, 报告, 截图和录屏 and leave empty ones out', () => {
  const data = empty()
  data.groups.captures.push({ group: 'captures', id: 'c', captureId: 'c', kind: 'image', title: null, webPath: null })
  data.groups.plans.push({ group: 'plans', id: 'p', artifactId: 'a', title: 'Plan', version: 2, kind: 'markdown' })
  data.count = 2
  assert.deepEqual(shownGroups(data).map(({ group, items }) => [group, items.length]), [['plans', 1], ['captures', 1]])
})

test('the read names the thread it lists, and nothing before the thread is known', () => {
  assert.equal(threadArtifactsPath('11111111-1111-4111-8111-111111111111'), '/api/mobile/threads/11111111-1111-4111-8111-111111111111/artifacts')
  assert.equal(threadArtifactsPath(null), null)
})
