import assert from 'node:assert/strict'
import test from 'node:test'
import { activityLabel, freshChunks, groupThreads, LAST_REPLY_CHARS, lastActivity, lastReplyUpdate, nextReply, pullRequestsOf, replyLine, threadGroup, type GroupIssue, type StoredReply, type ThreadOutcome } from './thread-groups'

const thread = (status: string, issueId: string | null = 'task', extra: { outcome?: ThreadOutcome | null; createdAt?: string; id?: string } = {}) =>
  ({ id: extra.id ?? status, status, issueId, createdAt: extra.createdAt ?? '2026-10-28T10:00:00Z', outcome: extra.outcome ?? null })
const pr = (number: number, state: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/acme/app/pull/${number}`, state })
const task = (status: string, ...pullRequests: ReturnType<typeof pr>[]): GroupIssue => ({ status, metadata: { pullRequests } })
const group = (t: ReturnType<typeof thread>, issue?: GroupIssue) => threadGroup(t, issue)
const ENDED = ['succeeded', 'stopped', 'failed', 'cancelled']

test('进行中: queued, preparing, running, finishing, whatever the task or outcome', () => {
  for (const status of ['queued', 'preparing', 'running', 'finishing']) {
    assert.equal(group(thread(status), task('done')), 'running', status)
    assert.equal(group(thread(status, null, { outcome: 'blocked' })), 'running', status)
  }
})

test('等待你: a run asking a question; 受阻: a run paused on its quota', () => {
  assert.equal(group(thread('waiting_input'), task('doing')), 'waiting')
  assert.equal(group(thread('paused'), task('doing')), 'blocked')
})

test('受阻: a run that finished but said it was blocked (not logged in, no credentials) is never resolved', () => {
  // "Not logged in · Please run /login", "gh 拿不到凭证": status succeeded, judged blocked.
  for (const status of ENDED) {
    assert.equal(group(thread(status, 'task', { outcome: 'blocked' }), task('doing')), 'blocked', status)
    assert.equal(group(thread(status, null, { outcome: 'failed' })), 'blocked', status)
  }
  // Even with a PR open on its task, a blocked run is 受阻, not a PR to review.
  assert.equal(group(thread('succeeded', 'task', { outcome: 'blocked' }), task('doing', pr(1, 'open'))), 'blocked')
})

test('等待你: judged needs_input, or its task has a PR to review', () => {
  assert.equal(group(thread('succeeded', 'task', { outcome: 'needs_input' }), task('doing')), 'waiting')
  assert.equal(group(thread('succeeded', 'task', { outcome: 'done' }), task('doing', pr(1, 'open'))), 'waiting')
  assert.equal(group(thread('succeeded', 'task', { outcome: 'idle' }), task('review')), 'waiting')
})

test('空闲: judged idle on an open task', () => {
  assert.equal(group(thread('stopped', 'task', { outcome: 'idle' }), task('todo')), 'idle')
  assert.equal(group(thread('stopped', null, { outcome: 'idle' })), 'idle')
})

test('已解决: judged done, or its task closed or its PR merged; nothing else', () => {
  assert.equal(group(thread('succeeded', 'task', { outcome: 'done' }), task('doing')), 'resolved')
  assert.equal(group(thread('succeeded', null, { outcome: 'done' })), 'resolved')
  for (const status of ['done', 'canceled', 'duplicate']) {
    assert.equal(group(thread('failed', 'task', { outcome: 'blocked' }), task(status)), 'resolved', status)
    assert.equal(group(thread('stopped'), task(status)), 'resolved', status)
  }
  assert.equal(group(thread('succeeded'), task('doing', pr(1, 'merged'))), 'resolved')
})

test('not judged yet: a failed run is 受阻, any other ended run 等待你, never 已解决', () => {
  assert.equal(group(thread('failed'), task('doing')), 'blocked')
  assert.equal(group(thread('failed', null)), 'blocked')
  for (const status of ['succeeded', 'stopped', 'cancelled']) {
    assert.equal(group(thread(status), task('doing')), 'waiting', status)
    assert.equal(group(thread(status, null)), 'waiting', status)
  }
})

test('a task\'s failed retries fold into its newest thread, which stays unresolved', () => {
  // The ZHIX-2 shape: one README task, many runs that failed or finished blocked.
  const runs = Array.from({ length: 16 }, (_, index) => thread(index % 2 ? 'failed' : 'succeeded', 'zhix-2', {
    id: `run-${index}`, createdAt: `2026-10-31T${String(index + 1).padStart(2, '0')}:00:00Z`, outcome: index % 2 ? 'failed' : 'blocked',
  }))
  const groups = groupThreads([...runs, thread('running', 'other', { id: 'live' })], id => id === 'zhix-2' ? task('todo') : task('doing'))
  assert.deepEqual(groups.resolved, [])
  assert.deepEqual(groups.blocked.map(row => [row.id, row.attempts]), [['run-15', 16]])
  assert.deepEqual(groups.running.map(row => [row.id, row.attempts]), [['live', 1]])
})

test('a superseded failed run no longer resolves itself: the task\'s newest run decides', () => {
  const failed = thread('failed', 'a', { id: 'old', createdAt: '2026-10-27T10:00:00Z', outcome: 'failed' })
  const retry = thread('failed', 'a', { id: 'retry', createdAt: '2026-10-28T10:00:00Z', outcome: 'blocked' })
  const groups = groupThreads([failed, retry], () => task('doing'))
  assert.deepEqual(groups.blocked.map(row => [row.id, row.attempts]), [['retry', 2]])
  assert.deepEqual(groups.resolved, [])
  // A retry that got it done resolves the task's row.
  const done = groupThreads([failed, { ...retry, status: 'succeeded', outcome: 'done' as const }], () => task('doing'))
  assert.deepEqual(done.resolved.map(row => row.id), ['retry'])
})

test('threads without a task are their own rows', () => {
  const groups = groupThreads([thread('stopped', null, { id: 'x', outcome: 'idle' }), thread('stopped', null, { id: 'y', outcome: 'idle' })], () => undefined)
  assert.deepEqual(groups.idle.map(row => [row.id, row.attempts]), [['x', 1], ['y', 1]])
})

test('a reply opening is one plain line', () => {
  assert.equal(replyLine('## 修好了\n\n**PR 已开**，见 [#247](https://github.com/a/b/pull/247)。\n- `pnpm test` 通过'), '修好了 PR 已开，见 #247。 pnpm test 通过')
  assert.equal(replyLine('Infisical 里 MIKKA_R2_ACCESS_KEY 没设'), 'Infisical 里 MIKKA_R2_ACCESS_KEY 没设')
  assert.equal(replyLine('看了 [[run:11111111-1111-4111-8111-111111111111]] 的日志'), '看了 的日志')
  assert.equal(replyLine(' \n '), null)
  assert.equal(replyLine(null), null)
})

test('a batch\'s reply text is the deltas of its last text part with text', () => {
  assert.deepEqual(lastReplyUpdate([{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: '修好了，' }, { type: 'text-delta', id: 'a', delta: 'PR 已开' }, { type: 'text-end', id: 'a' }]), { part: 'a', text: '修好了，PR 已开' })
  assert.deepEqual(lastReplyUpdate([{ type: 'text-delta', id: 'a', delta: 'one' }, { type: 'text-start', id: 'b' }, { type: 'text-delta', id: 'b', delta: '' }]), { part: 'a', text: 'one' })
  assert.equal(lastReplyUpdate([{ type: 'text-start', id: 'a' }, { type: 'tool-input-available' }]), null)
})

/** The events route in miniature: chunks keyed by seq (insert … on conflict do nothing), then nextReply on the fresh ones. */
function run() {
  const stored = new Map<number, Record<string, unknown>>()
  let reply: StoredReply = { lastReply: null, lastReplyPart: null }
  let writes = 0
  return {
    send(fromSeq: number, chunks: Record<string, unknown>[]) {
      const inserted = chunks.flatMap((chunk, index) => stored.has(fromSeq + index) ? [] : [fromSeq + index])
      for (const seq of inserted) stored.set(seq, chunks[seq - fromSeq])
      const next = nextReply(reply, freshChunks(chunks, fromSeq, inserted))
      if (next) { reply = next; writes += 1 }
      return reply
    },
    get writes() { return writes },
  }
}

test('an overlapping resend appends only its new text', () => {
  const r = run()
  r.send(10, [{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: '修好了' }])
  // The response was lost; the device sends 10–12 again and only 12 is new.
  const reply = r.send(10, [{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: '修好了' }, { type: 'text-delta', id: 'a', delta: '，PR 已开' }])
  assert.deepEqual(reply, { lastReply: '修好了，PR 已开', lastReplyPart: 'a' })
})

test('an identical resend changes nothing', () => {
  const r = run()
  const batch = [{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: '修好了' }]
  r.send(0, batch)
  assert.deepEqual(r.send(0, batch), { lastReply: '修好了', lastReplyPart: 'a' })
  assert.equal(r.writes, 1)
})

test('a new part replaces the old reply; more of the same part appends', () => {
  const r = run()
  r.send(0, [{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: '先看日志' }])
  r.send(2, [{ type: 'text-start', id: 'b' }])
  assert.deepEqual(r.send(3, [{ type: 'text-delta', id: 'b', delta: '日志里是 ETIMEDOUT' }]), { lastReply: '日志里是 ETIMEDOUT', lastReplyPart: 'b' })
  assert.deepEqual(r.send(4, [{ type: 'text-delta', id: 'b', delta: '，像是 Infisical 的出站' }]), { lastReply: '日志里是 ETIMEDOUT，像是 Infisical 的出站', lastReplyPart: 'b' })
  // A new part with only whitespace so far keeps the old reply.
  assert.equal(nextReply({ lastReply: 'x', lastReplyPart: 'b' }, [{ type: 'text-delta', id: 'c', delta: '\n' }]), null)
  // A batch that ends the stored part and opens the next with whitespace still appends the stored part's text.
  assert.deepEqual(nextReply({ lastReply: 'abc', lastReplyPart: 'a' }, [
    { type: 'text-delta', id: 'a', delta: 'def' }, { type: 'text-end', id: 'a' }, { type: 'text-start', id: 'b' }, { type: 'text-delta', id: 'b', delta: ' ' },
  ]), { lastReply: 'abcdef', lastReplyPart: 'a' })
})

test('the reply stops at 240 characters; once full only its time moves', () => {
  const long = '长'.repeat(230)
  const first = nextReply({ lastReply: null, lastReplyPart: null }, [{ type: 'text-delta', id: 'a', delta: long }])!
  const full = nextReply(first, [{ type: 'text-delta', id: 'a', delta: 'x'.repeat(30) }])!
  assert.equal(Array.from(full.lastReply!).length, LAST_REPLY_CHARS)
  assert.equal(full.lastReply, long + 'x'.repeat(10))
  assert.deepEqual(nextReply(full, [{ type: 'text-delta', id: 'a', delta: 'more' }]), full)
  assert.equal(Array.from(nextReply({ lastReply: null, lastReplyPart: null }, [{ type: 'text-delta', id: 'a', delta: '字'.repeat(300) }])!.lastReply!).length, LAST_REPLY_CHARS)
})

test('a row\'s time: 刚刚, 昨天, else relative; use the latest activity', () => {
  const now = new Date(2026, 9, 28, 9, 30)
  assert.equal(activityLabel(new Date(2026, 9, 28, 9, 29, 30), now), 'justNow')
  assert.equal(activityLabel(new Date(2026, 9, 28, 9, 25), now), 'relative')
  assert.equal(activityLabel(new Date(2026, 9, 27, 23, 50), now), 'yesterday')
  assert.equal(activityLabel(new Date(2026, 9, 26, 12, 0), now), 'relative')
  assert.equal(lastActivity({ lastReplyAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T09:10:00Z' }), '2026-10-28T09:10:00Z')
  assert.equal(lastActivity({ lastReplyAt: '2026-10-28T09:20:00Z', updatedAt: '2026-10-28T09:10:00Z' }), '2026-10-28T09:20:00Z')
  assert.equal(lastActivity({ lastReplyAt: null, updatedAt: '2026-10-28T09:10:00Z' }), '2026-10-28T09:10:00Z')
})

test('a bot\'s PRs come from the tasks its threads worked on', () => {
  const issues = [
    { id: 'a', metadata: { pullRequests: [pr(247, 'open')] } },
    { id: 'b', metadata: { pullRequests: [pr(251, 'open'), pr(250, 'closed')] } },
    { id: 'c', metadata: { pullRequests: [pr(240, 'merged')] } },
    { id: 'other', metadata: { pullRequests: [pr(9, 'open')] } },
  ]
  const rows = pullRequestsOf([thread('succeeded', 'a'), thread('running', 'b'), thread('succeeded', 'c'), thread('succeeded', 'b'), thread('running', null)], issues)
  assert.deepEqual(rows.map(row => [row.number, row.group, row.issueId, row.state]), [[247, 'review', 'a', 'open'], [251, 'running', 'b', 'open'], [240, 'merged', 'c', 'merged']])
})
