import assert from 'node:assert/strict'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { activityTimeline, deriveIssueActivity, pullLabel, type ActivityVersion } from './issue-activity'
import { mergeActivityEarlier } from './activity-page-cache'

function content(assignee: { id: string; name: string } | null): JSONContent {
  return {
    type: 'doc',
    attrs: {
      mikka: {
        assignee: assignee ? { kind: 'member', id: assignee.id, name: assignee.name, image: null } : null,
      },
    },
  }
}

test('without a body fingerprint a description autosave is not an event', () => {
  const changed = content({ id: 'u', name: 'Ada' })
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:01:00.000Z' },
    { id: 'v5', revision: 5, title: 'B', status: 'doing', priority: 'high', content: changed, createdAt: '2026-10-22T10:04:00.000Z' },
    { id: 'v3', revision: 3, title: 'B', status: 'doing', priority: 'high', content: changed, createdAt: '2026-10-22T10:02:00.000Z' },
  ], [
    { id: 'child', title: 'Sub', createdAt: '2026-10-22T10:03:00.000Z' },
  ])
  assert.deepEqual(events.map(event => event.kind).sort(), ['assigned', 'created', 'priority', 'status', 'subtask', 'title'])
  assert.equal(events.some(event => event.id.endsWith('v2') || event.id.endsWith('v5')), false)
  assert.equal(events.find(event => event.kind === 'assigned')?.assigneeName, 'Ada')
  assert.equal(events.find(event => event.kind === 'status')?.status, 'doing')
})

test('always keeps the created row when later events exceed the limit', () => {
  const versions = [{ id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' }]
  for (let revision = 2; revision <= 16; revision += 1) {
    versions.push({ id: `v${revision}`, revision, title: `T${revision}`, status: 'todo', priority: 'normal', content: content(null), createdAt: `2026-10-22T11:${String(revision).padStart(2, '0')}:00.000Z` })
  }
  const events = deriveIssueActivity(versions, [], 3)
  assert.equal(events[0]?.kind, 'created')
  assert.equal(events.length, 4)
  assert.deepEqual(events.slice(1).map(event => event.title), ['T14', 'T15', 'T16'])
})

const at = (minute: number) => `2026-10-22T10:${String(minute).padStart(2, '0')}:00.000Z`
function withAttrs(mikka: Record<string, unknown>, body = 'b0'): JSONContent {
  return { type: 'doc', attrs: { mikka: { assignee: null, ...mikka } }, bodyHash: body } as JSONContent
}
const version = (revision: number, mikka: Record<string, unknown>, body = 'b0', actor = 'user:u1'): ActivityVersion => {
  const [actorType, actorId] = actor.split(':') as ['user' | 'agent', string]
  return { id: 'v' + revision, revision, title: 'A', status: 'todo', priority: 'normal', content: withAttrs(mikka, body), createdAt: at(revision), actorType, actorId }
}

test('a hidden creation predecessor derives the boundary without displaying creation early', () => {
  const first = version(1, {})
  const second = { ...version(2, {}), title: 'Changed' }
  const initial = deriveIssueActivity([second], [], Infinity, first)
  assert.deepEqual(initial.map(event => event.kind), ['title'])
  assert.equal(initial[0].source?.id, second.id)
  assert.deepEqual(deriveIssueActivity([second, first], [], Infinity).map(event => event.kind), ['created', 'title'])
})

test('Capy events: description, parent, relations and pull requests; labels are not an event', () => {
  const parent = '11111111-1111-4111-8111-111111111111'
  const blocker = '22222222-2222-4222-8222-222222222222'
  const pr = 'https://github.com/acme/app/pull/12'
  const events = deriveIssueActivity([
    version(1, {}),
    version(2, {}, 'b1'),
    version(3, {}, 'b2'),
    version(4, { parentId: parent, labels: [{ name: 'QA', color: 'violet' }] }, 'b2'),
    version(5, { parentId: parent, blockedByIds: [blocker] }, 'b2'),
    version(6, { parentId: parent, blockedByIds: [blocker], pullRequests: [{ url: pr, state: 'open', title: 'Fix it' }] }, 'b2'),
    version(7, { parentId: parent, blockedByIds: [blocker], pullRequests: [{ url: pr, state: 'merged', title: 'Fix it' }] }, 'b2'),
    version(8, { pullRequests: [] }, 'b2'),
  ], [], Infinity)
  assert.deepEqual(events.map(event => event.kind === 'pull' ? `pull:${event.pull?.action}` : event.kind === 'relation' ? `relation:${event.relation}${event.removed ? ':off' : ''}` : event.kind === 'parent' ? `parent${event.removed ? ':off' : ''}` : event.kind), [
    'created', 'description', 'parent', 'relation:blockedBy', 'pull:linked', 'pull:merged', 'parent:off', 'pull:unlinked', 'relation:blockedBy:off',
  ])
  // Two autosaves by the same person with nothing between are one description event, at the last one.
  assert.equal(events.find(event => event.kind === 'description')?.at, at(3))
  assert.equal(events.find(event => event.kind === 'parent')?.targetId, parent)
  assert.deepEqual(events.find(event => event.kind === 'pull')?.pull, { label: 'app#12', href: pr, title: 'Fix it', action: 'linked' })
  assert.equal(pullLabel(pr), 'app#12')
})

test('description edits by another actor, or with an event between, stay separate', () => {
  const events = deriveIssueActivity([
    version(1, {}), version(2, {}, 'b1'), version(3, {}, 'b2', 'agent:a1'), version(4, { parentId: '11111111-1111-4111-8111-111111111111' }, 'b2'), version(5, {}, 'b3', 'agent:a1'),
  ], [], Infinity)
  // Events of one revision keep a stable order by id.
  assert.deepEqual(events.map(event => event.kind), ['created', 'description', 'description', 'parent', 'description', 'parent'])
})


test('records supported issue-attribute changes with the correct add/remove direction', () => {
  const before = content(null)
  const after = content(null)
  after.attrs = { mikka: {
    assignee: null, delegate: null, project: 'Launch', labels: [], pullRequests: [],
    parentId: '00000000-0000-4000-8000-000000000001',
    blockedByIds: ['00000000-0000-4000-8000-000000000002'],
    relatedIds: ['00000000-0000-4000-8000-000000000003'],
    dueDate: '2026-11-30', estimate: 5,
  } }
  const versions = [
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: before, createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: after, createdAt: '2026-10-22T10:01:00.000Z' },
    { id: 'v3', revision: 3, title: 'A', status: 'todo', priority: 'normal', content: before, createdAt: '2026-10-22T10:02:00.000Z' },
  ]
  const events = deriveIssueActivity(versions, [])
  const changes = (at: string) => events.filter(event => event.at === at).map(event => {
    if (event.kind === 'relation') return [event.relation, event.targetId, event.removed ?? false]
    if (event.kind === 'parent') return [event.kind, event.targetId ?? null, event.removed ?? false]
    return [event.kind]
  })
  const fields = [['dueDateChanged'], ['estimateChanged'], ['projectChanged']]
  const parent = '00000000-0000-4000-8000-000000000001'
  const blocker = '00000000-0000-4000-8000-000000000002'
  const related = '00000000-0000-4000-8000-000000000003'
  assert.deepEqual(changes(versions[1].createdAt).sort(), [...fields, ['parent', parent, false], ['blockedBy', blocker, false], ['related', related, false]].sort())
  assert.deepEqual(changes(versions[2].createdAt).sort(), [...fields, ['parent', null, true], ['blockedBy', blocker, true], ['related', related, true]].sort())
  assert.equal(events.find(event => event.kind === 'dueDateChanged')?.dueDate, '2026-11-30')
  assert.equal(events.find(event => event.kind === 'projectChanged')?.title, 'Launch')
  assert.equal(events.find(event => event.kind === 'estimateChanged')?.estimate, 5)
})

test('older meaningful activity survives more than fifty metadata-only autosave revisions', () => {
  const versions: ActivityVersion[] = [
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:01:00.000Z' },
  ]
  for (let revision = 3; revision <= 100; revision += 1) {
    versions.push({ id: `v${revision}`, revision, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: `2026-10-22T10:${String(revision % 60).padStart(2, '0')}:00.000Z` })
  }
  const events = deriveIssueActivity(versions, [], Infinity)
  assert.equal(events.some(event => event.kind === 'status' && event.source?.id === 'v2'), true)
  assert.equal(events.filter(event => event.kind !== 'created').length, 1)
})

test('records clearing an assignee and ignores subtasks created before the parent', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content({ id: 'u', name: 'Ada' }), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:05:00.000Z' },
  ], [
    { id: 'old', title: 'Older', createdAt: '2026-10-22T09:00:00.000Z' },
  ])
  assert.deepEqual(events.map(event => event.kind), ['created', 'unassigned'])
  assert.equal(events.find(event => event.kind === 'unassigned')?.assigneeName, 'Ada')
})

function responsibilityVersions(contents: JSONContent[]) {
  return contents.map((value, index) => ({
    id: `responsibility-${index + 1}`, revision: index + 1, title: 'A', status: 'todo', priority: 'normal', content: value,
    actorType: 'user' as const, actorId: 'owner', createdAt: `2026-11-07T10:${String(index).padStart(2, '0')}:00.000Z`,
  }))
}

test('legacy Agent assignee history remains visible as independent delegation events', () => {
  const agent = (id: string, name: string, legacy = false): JSONContent => ({
    type: 'doc', attrs: { [legacy ? 'orvilo' : 'mikka']: { assignee: { kind: 'agent', id, name, image: null } } },
  })
  const events = deriveIssueActivity(responsibilityVersions([
    content(null), agent('a', 'Old Agent', true), agent('b', 'Next Agent'), content(null),
  ]), [])
  assert.deepEqual(events.slice(1).map(event => [event.kind, event.assignmentTarget, event.assigneeName]), [
    ['assigned', 'delegate', 'Old Agent'], ['assigned', 'delegate', 'Next Agent'], ['unassigned', 'delegate', 'Next Agent'],
  ])
  assert.ok(events.every(event => event.actorKey === 'user:owner'))
})

test('moving a legacy Agent or Bot reference into delegate does not manufacture a change', () => {
  const legacy: JSONContent = { type: 'doc', attrs: { mikka: { assignee: { kind: 'agent', id: 'old', name: 'Executor', image: null } } } }
  for (const kind of ['agent', 'bot'] as const) {
    const migrated: JSONContent = { type: 'doc', attrs: { mikka: { assignee: null, delegate: { kind, id: 'old', name: 'Executor', image: null } } } }
    const contents = [content(null), legacy, migrated]
    const historical = structuredClone(contents)
    const events = deriveIssueActivity(responsibilityVersions(contents), [])
    assert.deepEqual(events.map(event => event.id), ['created-responsibility-1', 'delegate-assign-responsibility-2'])
    assert.deepEqual(contents, historical, 'deriving history never rewrites stored versions')
  }
})

test('human and Delegate changes in one version produce separate events and clearing delegation preserves the human', () => {
  const assigned = content({ id: 'person', name: 'Ada' })
  assigned.attrs!.mikka.delegate = { kind: 'profile', id: 'profile', name: 'Review profile', image: null }
  const cleared = content({ id: 'person', name: 'Ada' })
  cleared.attrs!.mikka.delegate = null
  const events = deriveIssueActivity(responsibilityVersions([content(null), assigned, cleared]), [])
  assert.deepEqual(events.slice(1).map(event => [event.id, event.kind, event.assignmentTarget, event.assigneeName]), [
    ['assign-responsibility-2', 'assigned', undefined, 'Ada'],
    ['delegate-assign-responsibility-2', 'assigned', 'delegate', 'Review profile'],
    ['delegate-unassign-responsibility-3', 'unassigned', 'delegate', 'Review profile'],
  ])
})

test('modern Delegate kind changes are real changes, while an explicit null overrides legacy history', () => {
  const reference = { id: 'same-id', name: 'Executor', image: null }
  const modern = (kind: 'agent' | 'bot'): JSONContent => ({ type: 'doc', attrs: { mikka: { assignee: null, delegate: { ...reference, kind } } } })
  const explicitlyCleared: JSONContent = { type: 'doc', attrs: { mikka: { assignee: { ...reference, kind: 'agent' }, delegate: null } } }
  const events = deriveIssueActivity(responsibilityVersions([modern('agent'), modern('bot'), explicitlyCleared]), [])
  assert.deepEqual(events.slice(1).map(event => [event.kind, event.assignmentTarget]), [['assigned', 'delegate'], ['unassigned', 'delegate']])
})

test('a subtask keeps its identifier so the activity line can name and open it', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' },
  ], [
    { id: 'child', title: 'Sub', identifier: 'MIK-13', createdAt: '2026-10-22T10:03:00.000Z' },
  ])
  const subtask = events.find(event => event.kind === 'subtask')
  assert.equal(subtask?.targetId, 'child')
  assert.equal(subtask?.code, 'MIK-13')
  assert.equal(subtask?.title, 'Sub')
})

test('every event is its own row, as Capy\'s log', () => {
  const rows = activityTimeline([
    { id: 'a', at: '2026-10-22T10:00:05.000Z', kind: 'created', actorKey: 'user:u1' },
    { id: 'b', at: '2026-10-22T10:00:20.000Z', kind: 'assigned', assigneeName: 'Ada', actorKey: 'user:u1' },
    { id: 'c', at: '2026-10-22T10:00:40.000Z', kind: 'status', status: 'doing', actorKey: 'agent:a1' },
  ], [])
  assert.deepEqual(rows.map(row => row.type === 'events' ? row.events.map(event => event.id) : []), [['a'], ['b'], ['c']])
})

test('derived events carry the version actor', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z', actorType: 'user', actorId: 'u1' },
    { id: 'v2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:30.000Z', actorType: 'agent', actorId: 'a1' },
  ], [])
  assert.deepEqual(events.map(event => event.actorKey), ['user:u1', 'agent:a1'])
})

test('derived events carry the resolved actor the sentence starts with', () => {
  const ada = { type: 'user' as const, id: 'u1', name: 'Ada', avatarUrl: '/avatars/blue.webp' }
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z', actorType: 'user', actorId: 'u1', actor: ada },
    { id: 'v2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:05:00.000Z' },
  ], [])
  assert.deepEqual(events.map(event => event.actor ?? null), [ada, null])
})

test('interleaves task events and dispatched threads by time (#1264)', () => {
  const events = deriveIssueActivity([
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-11-04T20:44:00.000Z' },
    { id: 'v2', revision: 2, title: 'A', status: 'in_review', priority: 'normal', content: content(null), createdAt: '2026-11-04T20:49:30.000Z' },
  ], [])
  const rows = activityTimeline(events, [
    { id: 't3', createdAt: new Date('2026-11-04T20:51:00.000Z') },
    { id: 't1', createdAt: new Date('2026-11-04T20:45:00.000Z') },
    { id: 't2', createdAt: '2026-11-04T20:49:10.000Z' },
  ])
  assert.deepEqual(rows.map(row => row.id), ['created-v1', 'thread-t1', 'thread-t2', 'status-v2', 'thread-t3'])
})

test('keeps same-time rows in a stable order and places threads between events', () => {
  const at = '2026-11-04T20:49:00.000Z'
  const event = (id: string, second: string) => ({ id, at: `2026-11-04T20:49:${second}.000Z`, kind: 'status' as const, actorKey: 'user:u' })
  const threads = [{ id: 'b', createdAt: at }, { id: 'a', createdAt: at }]
  const once = activityTimeline([event('e2', '00'), event('e1', '00')], threads)
  const again = activityTimeline([event('e1', '00'), event('e2', '00')], [...threads].reverse())
  assert.deepEqual(once.map(row => row.id), ['e1', 'e2', 'thread-a', 'thread-b'])
  assert.deepEqual(once, again)
  const split = activityTimeline([event('e1', '10'), event('e2', '50')], [{ id: 't', createdAt: '2026-11-04T20:49:30.000Z' }])
  assert.deepEqual(split.map(row => row.id), ['e1', 'thread-t', 'e2'])
})

test('a missing revision window cannot reassign creation or skipped changes to another actor', () => {
  const sample = (revision: number, title: string): ActivityVersion => ({
    id: 'v' + revision, revision, title, status: 'todo', priority: 'normal', content: content(null),
    createdAt: new Date(revision * 1000), actorType: 'user', actorId: 'actor-' + revision,
  })
  const recent = [sample(80, 'From the missing page'), sample(81, 'Actual edit')]
  assert.deepEqual(deriveIssueActivity(recent, []).map(event => event.id), ['title-v81'])
  assert.deepEqual(deriveIssueActivity([sample(1, 'Created'), ...recent], []).map(event => event.id),
    ['created-v1', 'title-v81'])
})

test('Activity assigns each canonical Bot update one card and keeps same-text discussion and replies under their real identities', async () => {
  const { taskActivityFacts, taskActivityThreads } = await import('./task-activity-timeline')
  const at = '2026-11-15T00:00:00Z'
  const stage = { id: 'stage', author: 'Bot', at, body: 'Review' }
  const human = { ...stage, id: 'reply', author: 'Alex', authorUserId: 'owner' }
  const bot = { ...stage, id: 'genuine-bot-comment' }
  const accepted = { ...stage, id: 'accept', body: 'Accepted' }
  const late = { ...human, id: 'late-reply-to-review', replyToMessageId: stage.id }
  const mixed = { id: 'factory', author: 'Bot', createdAt: at, resolved: true, messages: [stage, human, bot, accepted, late] }
  const other = { ...mixed, id: 'other', messages: [stage] }
  const refs = [{ threadId: 'factory', messageId: 'stage' }, { threadId: 'factory', messageId: 'accept' }]
  const facts = taskActivityFacts([], [mixed, other], refs).filter(fact => fact.kind !== 'history')
  assert.deepEqual(facts.filter(fact => fact.actor === 'bot').map(fact => [fact.id, fact.kind, fact.author, fact.body]), [
    ['discussion:factory:accept', 'comment', 'Bot', 'Accepted'], ['discussion:factory:stage', 'comment', 'Bot', 'Review'],
  ])
  assert.deepEqual(facts.filter(fact => !fact.actor).map(fact => fact.id).sort(), [
    'discussion:factory:reply', 'discussion:factory:late-reply-to-review', 'discussion:factory:genuine-bot-comment', 'discussion:other:stage',
  ].sort())
  const groups = taskActivityThreads([mixed, other], refs)
  assert.deepEqual(groups.map(group => group.thread.messages.map(message => message.id)), [
    ['stage', 'reply', 'genuine-bot-comment', 'late-reply-to-review'], ['accept'], ['stage'],
  ])
  assert.equal(groups[2].thread, other)
  assert.ok(groups.slice(0, 2).every(group => group.thread.id === mixed.id && group.thread.resolved))
  assert.equal(mixed.messages.length, 5)
})

test('coalesces consecutive same-actor description saves without losing older narrated changes', () => {
  const versions: ActivityVersion[] = [
    { id: 'v1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z', actorType: 'user', actorId: 'u' },
    { id: 'v2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:01:00.000Z', actorType: 'user', actorId: 'u' },
  ]
  for (let revision = 3; revision <= 102; revision += 1) versions.push({
    id: `v${revision}`, revision, title: 'A', status: 'doing', priority: 'normal', content: content(null),
    createdAt: new Date(Date.UTC(2026, 9, 22, 10, revision)).toISOString(), actorType: 'user', actorId: 'u', descriptionChanged: true,
  })
  const events = deriveIssueActivity(versions, [], Infinity)
  assert.deepEqual(events.map(event => event.kind), ['created', 'status', 'description'])
  assert.equal(events.at(-1)?.id, 'description-v102', 'a save streak is represented by its latest edit')
  const lastEvent = events.at(-1)
  assert.equal(lastEvent?.source?.kind, 'revision')
  if (lastEvent?.source?.kind === 'revision') assert.equal(lastEvent.source.revision, 102)

  const unknownActor = deriveIssueActivity([
    { id: 'u1', revision: 1, title: 'A', status: 'todo', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:00:00.000Z' },
    { id: 'u2', revision: 2, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:01:00.000Z' },
    { id: 'u3', revision: 3, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:02:00.000Z', descriptionChanged: true },
    { id: 'u4', revision: 4, title: 'A', status: 'doing', priority: 'normal', content: content(null), createdAt: '2026-10-22T10:03:00.000Z', descriptionChanged: true },
  ], [], Infinity)
  assert.deepEqual(unknownActor.map(event => event.kind), ['created', 'status', 'description'])
  assert.equal(unknownActor.at(-1)?.id, 'description-u4', 'unknown actors may coalesce only across the same consecutive save streak')
})


test('older meaningful events survive a save streak spanning several revision pages', () => {
  const versions: ActivityVersion[] = Array.from({ length: 305 }, (_, i) => {
    const revision = i + 1
    return {
      id: `long-${revision}`, revision, title: revision === 1 ? 'Before' : 'Renamed',
      status: 'todo', priority: 'normal', content: content(null),
      actorType: 'user', actorId: 'u', descriptionChanged: revision >= 3,
      createdAt: new Date(Date.UTC(2026, 9, 22, 10, 0, revision)).toISOString(),
    }
  })
  const newestFirst = [...versions].reverse()
  let page = { version: 'v305', items: newestFirst.slice(0, 101), hasMore: true }
  let events = deriveIssueActivity(page.items, [], Infinity)
  assert.deepEqual(events.map(event => event.id), ['description-long-305'])
  for (let offset = 101; offset < newestFirst.length; offset += 101) {
    const beforeId = page.items.at(-1)!.id
    page = mergeActivityEarlier(page, beforeId, { items: newestFirst.slice(offset, offset + 101), hasMore: offset + 101 < newestFirst.length })!
    assert.equal(new Set(page.items.map(item => item.id)).size, page.items.length)
    events = deriveIssueActivity(page.items, [], Infinity)
    assert.equal(events.filter(event => event.kind === 'description').length, 1)
    assert.equal(events.at(-1)?.id, 'description-long-305')
  }
  assert.equal(page.items.length, 305)
  assert.equal(page.hasMore, false)
  assert.deepEqual(events.map(event => event.id), ['created-long-1', 'title-long-2', 'description-long-305'])
})

test('revision activity carries only recorded run provenance, leaving legacy rows unlinked', () => {
  const versions = [version(1, {}), { ...version(2, {}, 'b0', 'agent:a'), title: 'Legacy' }, { ...version(3, {}, 'b0', 'agent:a'), title: 'Run update', sourceRunId: 'run-1' }]
  const events = deriveIssueActivity(versions, [], Infinity)
  const legacy = events.find(event => event.id === 'title-v2')
  const sourced = events.find(event => event.id === 'title-v3')
  assert.equal(legacy?.source?.kind === 'revision' ? legacy.source.runId : undefined, null)
  assert.equal(sourced?.source?.kind === 'revision' ? sourced.source.runId : undefined, 'run-1')
})
