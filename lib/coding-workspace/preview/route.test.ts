import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { TaskReviewAuthority } from '../review-authority'

class AuthorityFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
  detail = undefined
}
class RuntimeFailure extends Error {
  code = 'review_preview_unavailable'
  constructor(readonly detail: string, readonly status = 503, options?: ErrorOptions) { super(detail, options) }
}
const authority = { taskId: 'task-fixture', runId: 'run-fixture', bindingId: 'binding-fixture' } as TaskReviewAuthority
const lease = { id: 'lease-fixture', expiresAt: new Date(Date.now() + 60_000).toISOString() }
const client = { fixture: true }
const state = {
  events: [] as string[], locked: false, reads: 0, denyRead: 0, absent: false,
  pending: 0, authorityFailure: undefined as Error | undefined, issueFailure: undefined as Error | undefined,
}
const outsideLock = (name: string) => {
  assert.equal(state.locked, false, `${name} must not hold database authorization locks`)
  state.events.push(name)
}

mock.module('../review-authority', { namedExports: {
  ReviewAuthorityError: AuthorityFailure,
  taskReviewAuthority: async () => {
    state.events.push('authorize')
    if (state.authorityFailure) throw state.authorityFailure
    return authority
  },
  withTaskReviewAuthority: async (_request: Request, taskId: string, callback: (scope: TaskReviewAuthority, database: typeof client) => Promise<unknown>, expected: { runId: string; bindingId: string }) => {
    assert.equal(taskId, authority.taskId)
    assert.deepEqual(expected, { runId: authority.runId, bindingId: authority.bindingId })
    assert.equal(state.locked, false)
    state.locked = true
    try { return await callback(authority, client) } finally { state.locked = false }
  },
} })
mock.module('../review-sessions', { namedExports: {
  beginReviewSession: async (scope: TaskReviewAuthority, input: { kind: string }, database: typeof client) => {
    assert.equal(state.locked, true)
    assert.equal(scope, authority)
    assert.equal(database, client)
    assert.equal(input.kind, 'preview')
    state.events.push('begin')
    return lease
  },
  readReviewSession: async (scope: TaskReviewAuthority, input: { kind: string; id: string }, database: typeof client) => {
    assert.equal(state.locked, true)
    assert.equal(scope, authority)
    assert.equal(database, client)
    assert.deepEqual(input, { kind: 'preview', id: lease.id })
    state.events.push('read')
    return ++state.reads === state.denyRead ? null : lease
  },
  revokeReviewSession: async (scope: TaskReviewAuthority, input: { kind: string; id: string }) => {
    outsideLock('durable-revoke')
    assert.equal(scope, authority)
    assert.deepEqual(input, { kind: 'preview', id: lease.id })
    return { closed: state.pending ? 0 : 1, pending: state.pending }
  },
} })
mock.module('../review-machine', { namedExports: {
  resumeReviewMachine: async (scope: TaskReviewAuthority, current: typeof lease) => {
    outsideLock('resume')
    assert.equal(scope, authority)
    assert.equal(current.id, lease.id)
  },
} })
mock.module('./runtime', { namedExports: {
  PreviewRuntimeError: RuntimeFailure,
  previewParentOrigin: () => 'https://mikka.example.test',
  prepareRunPreview: async (scope: TaskReviewAuthority, options: { expiresAt: string }) => {
    outsideLock('prepare')
    assert.equal(scope, authority)
    assert.equal(options.expiresAt, lease.expiresAt)
    return state.absent ? { running: false, code: 'no_loopback_server' }
      : { running: true, expiresAt: lease.expiresAt }
  },
  issueRunPreview: async (_prepared: unknown, parent: string, current: typeof lease) => {
    outsideLock('issue')
    assert.equal(parent, 'https://mikka.example.test')
    assert.deepEqual(current, lease)
    if (state.issueFailure) throw state.issueFailure
    return { running: true, url: 'https://isolated.example.test/__mikka/preview/open?ticket=synthetic' }
  },
} })
const { reviewPreviewRoute } = await import('./route')
const request = (suffix = '') => new Request(`https://mikka.example.test/api/tasks/task-fixture/review/preview${suffix}`)
beforeEach(() => {
  state.events = []; state.locked = false; state.reads = 0; state.denyRead = 0
  state.absent = false; state.pending = 0; state.authorityFailure = undefined; state.issueFailure = undefined
})

test('returns the exact frontend discriminant only after both locked lease checks, with E2B outside locks', async () => {
  const response = await reviewPreviewRoute(request(), authority.taskId)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), { running: true, url: 'https://isolated.example.test/__mikka/preview/open?ticket=synthetic' })
  assert.deepEqual(state.events, ['authorize', 'begin', 'resume', 'prepare', 'read', 'issue', 'read'])
})

test('a teammate or cross-workspace refusal performs no lease or remote operation', async () => {
  for (const code of ['not_owner_terminal', 'review_scope_denied']) {
    state.events = []
    state.authorityFailure = new AuthorityFailure(code, 403)
    const response = await reviewPreviewRoute(request(), authority.taskId)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, code)
    assert.deepEqual(state.events, ['authorize'])
  }
})

test('revocation before signing suppresses the capability and durably closes its prepared lease', async () => {
  state.denyRead = 1
  const response = await reviewPreviewRoute(request(), authority.taskId)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).detail, 'scope_changed')
  assert.deepEqual(state.events, ['authorize', 'begin', 'resume', 'prepare', 'read', 'durable-revoke'])
})

test('revocation concurrent with signing never releases the one-use URL to the caller', async () => {
  state.denyRead = 2
  const response = await reviewPreviewRoute(request(), authority.taskId)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).url, undefined)
  assert.deepEqual(state.events, ['authorize', 'begin', 'resume', 'prepare', 'read', 'issue', 'read', 'durable-revoke'])
})

test('absence uses frontend 404 and releases the unused lease after durable revocation acknowledgement', async () => {
  state.absent = true
  const response = await reviewPreviewRoute(request(), authority.taskId)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { running: false, code: 'no_loopback_server' })
  assert.deepEqual(state.events, ['authorize', 'begin', 'resume', 'prepare', 'durable-revoke'])
})

test('a failed remote issue with pending durable cleanup fails closed and leaves no success response', async () => {
  state.issueFailure = new RuntimeFailure('runtime')
  state.pending = 1
  const response = await reviewPreviewRoute(request(), authority.taskId)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'review_preview_unavailable')
  assert.equal(state.events.filter(event => event === 'durable-revoke').length, 1)
})

test('arbitrary destinations and duplicate ports are rejected before a lease is created', async () => {
  for (const query of ['?url=http://169.254.169.254/', '?port=3000&port=3001']) {
    state.events = []
    const response = await reviewPreviewRoute(request(query), authority.taskId)
    assert.equal(response.status, 400)
    assert.deepEqual(state.events, ['authorize'])
  }
})
