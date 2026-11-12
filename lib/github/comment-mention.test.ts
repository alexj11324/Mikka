import assert from 'node:assert/strict'
import test from 'node:test'
import { commentMentionEvent, commentMentionPattern } from './comment-mention.ts'

const repo = 'acme/widgets'
const prUrl = `https://github.com/${repo}/pull/42`
/** The App-slug input is required (see the module contract); null = unconfigured. */
const noSlug = { appSlug: null }

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    repository: { full_name: repo, archived: false },
    sender: { type: 'User', login: 'alex' },
    issue: { number: 42, pull_request: { html_url: prUrl } },
    comment: {
      id: 9001,
      body: '@mikka SECRET_BODY please take a look',
      user: { type: 'User', login: 'alex' },
      html_url: `${prUrl}#issuecomment-9001`,
    },
    ...overrides,
  }
}

function reviewPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    repository: { full_name: repo, archived: false },
    sender: { type: 'User', login: 'alex' },
    pull_request: { number: 42, html_url: prUrl },
    comment: {
      id: 9002,
      body: '@mikka check this line',
      user: { type: 'User', login: 'alex' },
      html_url: `${prUrl}#discussion_r9002`,
    },
    ...overrides,
  }
}

/** A copy without `key`, for "missing" rather than explicit-undefined cases. */
function without(payload: Record<string, unknown>, key: string) {
  const copy = { ...payload }
  delete copy[key]
  return copy
}

test('an issue_comment mention on a PR returns identities, never the body', () => {
  const result = commentMentionEvent('issue_comment', issuePayload(), noSlug)
  assert.deepEqual(result, {
    kind: 'issue_comment',
    repo,
    pullNumber: 42,
    commentId: 9001,
    author: 'alex',
    commentUrl: `${prUrl}#issuecomment-9001`,
  })
  assert.equal('body' in result!, false)
  assert.equal(JSON.stringify(result).includes('SECRET_BODY'), false)
})

test('a review comment returns its discussion permalink', () => {
  assert.deepEqual(commentMentionEvent('pull_request_review_comment', reviewPayload(), noSlug), {
    kind: 'pull_request_review_comment',
    repo,
    pullNumber: 42,
    commentId: 9002,
    author: 'alex',
    commentUrl: `${prUrl}#discussion_r9002`,
  })
})

test('@mikka-github is accepted only when the configured slug is passed', () => {
  const payload = issuePayload({
    comment: { id: 1, body: '@mikka-github have a look', user: { type: 'User', login: 'alex' } },
  })
  assert.equal(commentMentionEvent('issue_comment', payload, noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', payload, { appSlug: 'mikka-github' })?.commentId, 1)
  assert.equal(commentMentionEvent('issue_comment', issuePayload(), { appSlug: 'mikka-github' })?.commentId, 9001)
})

test('mentions are case-insensitive', () => {
  for (const body of ['@MiKkA look', '@MIKKA', '@Mikka-github ping']) {
    const payload = issuePayload({ comment: { id: 2, body, user: { type: 'User', login: 'alex' } } })
    assert.equal(commentMentionEvent('issue_comment', payload, { appSlug: 'mikka-github' })?.commentId, 2, body)
  }
})

test('the mention needs a word boundary before it and a non-word character after it', () => {
  const cases: [string, boolean][] = [
    ['@mikka please', true],
    ['hello @mikka', true],
    ['(@mikka)', true],
    ['@mikka.', true],
    ['hello@mikka', false],
    ['@mikkas', false],
    ['@mikka-x', false],
    ['@mikka_x', false],
  ]
  for (const [body, expected] of cases) {
    const payload = issuePayload({ comment: { id: 3, body, user: { type: 'User', login: 'alex' } } })
    assert.equal(Boolean(commentMentionEvent('issue_comment', payload, noSlug)), expected, body)
  }
})

test('the exported pattern follows the same boundary rules', () => {
  const pattern = commentMentionPattern('mikka-github')
  assert.equal(pattern.test('@mikka-github'), true)
  assert.equal(pattern.test('x @MIKKA-github.'), true)
  assert.equal(pattern.test('@mikka-githubs'), false)
  assert.equal(pattern.test('@mikka-github-'), false)
  assert.equal(pattern.test('@other'), false)
})

test('an archived repository is ignored; a missing flag is not archived', () => {
  assert.equal(commentMentionEvent('issue_comment', issuePayload({ repository: { full_name: repo, archived: true } }), noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({ repository: { full_name: repo } }), noSlug)?.commentId, 9001)
})

test('only created comments produce an event', () => {
  for (const action of ['edited', 'deleted', 'created ']) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ action }), noSlug), null, action)
  }
  assert.equal(commentMentionEvent('issue_comment', issuePayload({ action: 'created' }), noSlug)?.commentId, 9001)
})

test('a missing or null action never produces an event', () => {
  for (const payload of [
    without(issuePayload(), 'action'),
    issuePayload({ action: undefined }),
    issuePayload({ action: null }),
    {},
  ]) {
    assert.equal(commentMentionEvent('issue_comment', payload, noSlug), null, JSON.stringify(payload).slice(0, 80))
  }
})

test('a non-PR issue is ignored', () => {
  for (const pullRequest of [undefined, null, 'https://github.com/acme/widgets/pull/42', [prUrl]]) {
    const issue = { number: 42, ...(pullRequest === undefined ? {} : { pull_request: pullRequest }) }
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ issue }), noSlug), null, String(pullRequest))
  }
})

test('a bot or our own comment never feeds back in, on either side', () => {
  // sender is a bot, commenter is human
  assert.equal(commentMentionEvent('issue_comment', issuePayload({ sender: { type: 'Bot', login: 'someone' } }), noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({ sender: { type: 'User', login: 'dependabot[bot]' } }), noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({ sender: { type: 'User', login: 'mikka-github[bot]' } }), { appSlug: 'mikka-github' }), null)
  // commenter is a bot, sender is human
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 4, body: '@mikka', user: { type: 'Bot', login: 'someone' } },
  }), noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 5, body: '@mikka', user: { type: 'User', login: 'dependabot[bot]' } },
  }), noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 6, body: '@mikka', user: { type: 'User', login: 'Mikka-GitHub[Bot]' } },
  }), { appSlug: 'mikka-github' }), null)
  // a human pair still matches
  assert.equal(commentMentionEvent('issue_comment', issuePayload(), noSlug)?.commentId, 9001)
})

test('a review comment needs a positive pull_request.number', () => {
  for (const number of [0, -1, 1.5, '42', undefined]) {
    assert.equal(commentMentionEvent('pull_request_review_comment', reviewPayload({
      pull_request: { number },
    }), noSlug), null, String(number))
  }
  assert.equal(commentMentionEvent('pull_request_review_comment', reviewPayload({
    pull_request: { number: 7 },
  }), noSlug)?.pullNumber, 7)
})

test('a missing or non-object issue or review pull_request is ignored', () => {
  assert.equal(commentMentionEvent('issue_comment', without(issuePayload(), 'issue'), noSlug), null)
  for (const issue of [undefined, null, 'x', 42]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ issue }), noSlug), null, String(issue))
  }
  assert.equal(commentMentionEvent('pull_request_review_comment', without(reviewPayload(), 'pull_request'), noSlug), null)
  for (const pullRequest of [undefined, null, 'x', 42]) {
    assert.equal(commentMentionEvent('pull_request_review_comment', reviewPayload({ pull_request: pullRequest }), noSlug), null, String(pullRequest))
  }
})

test('a missing or non-object comment and a non-string body are ignored', () => {
  for (const comment of [without(issuePayload(), 'comment'), issuePayload({ comment: undefined }).comment, null, 42, 'x', []]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ comment }), noSlug), null, String(comment))
  }
  for (const body of [undefined, null, 42, ['@mikka']]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({
      comment: { id: 7, body, user: { type: 'User', login: 'alex' } },
    }), noSlug), null, String(body))
  }
})

test('a comment body at the 64 KiB limit is accepted and one byte over is ignored', () => {
  const exact = `@mikka ${'a'.repeat(64 * 1024 - 7)}`
  const over = `@mikka ${'a'.repeat(64 * 1024 - 6)}`
  assert.equal(Buffer.byteLength(exact), 64 * 1024)
  assert.equal(Buffer.byteLength(over), 64 * 1024 + 1)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 6, body: exact, user: { type: 'User', login: 'alex' } },
  }), noSlug)?.commentId, 6)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 7, body: over, user: { type: 'User', login: 'alex' } },
  }), noSlug), null)
})

test('multibyte text is measured in UTF-8 bytes, not UTF-16 units', () => {
  const body = `@mikka ${'é'.repeat(40_000)}`
  assert.ok(body.length < 64 * 1024)
  assert.ok(Buffer.byteLength(body) > 64 * 1024)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 8, body, user: { type: 'User', login: 'alex' } },
  }), noSlug), null)
})

test('a missing or non-object repository is ignored', () => {
  for (const repository of [without(issuePayload(), 'repository'), issuePayload({ repository: undefined }).repository, null, 'acme/widgets', 42, []]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ repository }), noSlug), null, String(repository))
  }
})

test('invalid repository names are ignored', () => {
  for (const full_name of ['', 'widgets', 'a/b/c', 'acme widgets', 'acme/widgets\n']) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ repository: { full_name } }), noSlug), null, JSON.stringify(full_name))
  }
})

test('a non-string repository full_name is ignored', () => {
  for (const full_name of [undefined, null, 42, ['acme/widgets']]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({ repository: { full_name } }), noSlug), null, String(full_name))
  }
})

test('comment ids must be positive safe integers', () => {
  for (const id of [0, -1, 1.5, '9001', Number.MAX_SAFE_INTEGER + 1, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({
      comment: { id, body: '@mikka', user: { type: 'User', login: 'alex' } },
    }), noSlug), null, String(id))
  }
})

test('a missing or empty author login is ignored', () => {
  for (const user of [undefined, null, {}, { login: '' }, { login: 42 }]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({
      comment: { id: 9, body: '@mikka', ...(user === undefined ? {} : { user }) },
    }), noSlug), null, JSON.stringify(user))
  }
})

test('malformed payloads and unknown events are ignored', () => {
  for (const payload of [null, undefined, 'text', 42, []]) {
    assert.equal(commentMentionEvent('issue_comment', payload, noSlug), null, String(payload))
  }
  for (const event of [null, '', 'pull_request', 'issues', 'issue_comment ']) {
    assert.equal(commentMentionEvent(event, issuePayload(), noSlug), null, String(event))
  }
})

test('an issue_comment needs a positive issue number', () => {
  for (const number of [0, -1, 1.5, '42', undefined]) {
    assert.equal(commentMentionEvent('issue_comment', issuePayload({
      issue: { number, pull_request: { html_url: prUrl } },
    }), noSlug), null, String(number))
  }
})

test('a comment without the mention is ignored', () => {
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 10, body: 'just a normal comment', user: { type: 'User', login: 'alex' } },
  }), noSlug), null)
  assert.equal(commentMentionEvent('issue_comment', issuePayload({
    comment: { id: 11, body: '', user: { type: 'User', login: 'alex' } },
  }), noSlug), null)
})
