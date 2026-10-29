import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareTeamPromotion, submitTeamPromotion, type TeamPromotionIntent } from './issue-team-intent'

const task = { id: 'task-a', revision: 3 }
const choice = { issueId: task.id, teamId: 'team-a', selectionId: 'human-save-a' }

test('persisted team, missing choice and another task never supply sharing intent', () => {
  const noRequest = () => { throw Error('must not create a request') }
  for (const selection of [undefined, null, { ...choice, issueId: 'task-b' }, { ...choice, teamId: '' }]) {
    assert.deepEqual(prepareTeamPromotion(task, selection, 'team-a', null, noRequest), { error: 'issueScopeTeamRequired' })
  }
})

test('unknown, missing or changed current relation rejects a saved choice', () => {
  for (const current of [undefined, null, 'team-b']) {
    assert.deepEqual(prepareTeamPromotion(task, choice, current, null, () => { throw Error('no request') }), { error: 'teamIssueChanged' })
  }
})

test('an explicit saved target freezes the exact public action body and same-request retry', () => {
  let ids = 0
  const first = prepareTeamPromotion(task, choice, choice.teamId, null, () => `request-${++ids}`)
  assert.ok(first.intent)
  assert.deepEqual(first.intent.input, { requestId: 'request-1', issueId: task.id, revision: 3, teamId: 'team-a', expectedTeamId: 'team-a' })
  assert.ok(Object.isFrozen(first.intent.input))
  const retry = prepareTeamPromotion({ ...task }, { ...choice }, 'team-a', first.intent, () => `request-${++ids}`)
  assert.equal(retry.intent, first.intent)
  assert.equal(ids, 1)
})

test('revision changes or switched target cannot silently replace an uncertain request', () => {
  const first = prepareTeamPromotion(task, choice, 'team-a', null, () => 'request-1')
  assert.ok(first.intent)
  assert.deepEqual(prepareTeamPromotion({ ...task, revision: 4 }, choice, 'team-a', first.intent, () => { throw Error('no replacement') }), { error: 'teamIssueChanged' })
  assert.deepEqual(prepareTeamPromotion(task, { ...choice, teamId: 'team-b' }, 'team-b', first.intent, () => { throw Error('no replacement') }), { error: 'teamIssueChanged' })
  assert.equal(first.intent.input.revision, 3)
  assert.equal(first.intent.input.teamId, 'team-a')
})

test('only a new explicit save event starts a new intent', () => {
  const first = prepareTeamPromotion(task, choice, 'team-a', null, () => 'request-1')
  assert.ok(first.intent)
  const next = prepareTeamPromotion(task, { ...choice, selectionId: 'human-save-b', teamId: 'team-b' }, 'team-b', first.intent, () => 'request-2')
  assert.ok(next.intent)
  assert.equal(next.intent.input.requestId, 'request-2')
  assert.equal(next.intent.input.teamId, 'team-b')
})

test('async relation barrier: clearing/changing selection, task/revision change and unmount prevent any action', async () => {
  for (const change of ['cleared', 'unsaved-other-team', 'other-task', 'new-revision', 'unmounted']) {
    let current = true, calls = 0, ids = 0, remembered = 0
    let release!: (team: string) => void
    const relation = new Promise<string>(resolve => { release = resolve })
    const result = submitTeamPromotion(task, choice, null, {
      isCurrent: () => current, readTeam: () => relation,
      requestId: () => { ids++; return 'request-1' }, remember: () => { remembered++ },
      promote: async () => { calls++; return { issue: { id: task.id } } },
    })
    current = false; release('team-a')
    assert.deepEqual(await result, { error: 'teamIssueChanged' }, change)
    assert.deepEqual({ calls, ids, remembered }, { calls: 0, ids: 0, remembered: 0 }, change)
  }
})

test('late action response is not adopted after the UI context retires', async () => {
  let current = true, release!: () => void, dispatched!: () => void
  const entered = new Promise<void>(resolve => { dispatched = resolve })
  const response = new Promise<void>(resolve => { release = resolve })
  const result = submitTeamPromotion(task, choice, null, {
    isCurrent: () => current, readTeam: async () => 'team-a', requestId: () => 'request-1', remember: () => {},
    promote: async () => { dispatched(); await response; return { issue: { id: task.id } } },
  })
  await entered; current = false; release()
  assert.deepEqual(await result, { error: 'teamIssueChanged' })
})

test('unknown-outcome retry uses the remembered exact request through the actual async handler', async () => {
  let previous: TeamPromotionIntent | null = null, ids = 0
  const requests: unknown[] = []
  const deps = { isCurrent: () => true, readTeam: async () => 'team-a', requestId: () => `request-${++ids}`,
    remember: (intent: TeamPromotionIntent) => { previous = intent },
    promote: async (input: unknown) => { requests.push(input); return { error: 'teamIssueOutcomeUnknown' } } }
  await submitTeamPromotion(task, choice, previous, deps)
  await submitTeamPromotion(task, choice, previous, deps)
  assert.equal(ids, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0], requests[1])
})
