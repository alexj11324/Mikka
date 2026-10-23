import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { briefingContent, localDate, safeTimeZone } from './briefing'
import { verifyGitHubSignature } from './github-webhook'
import { composioNotification, githubCandidateIds, githubNotification, gmailNotification, linearCommentNotification, linearIssueNotification, slackNotification, type ExternalNotification } from './notification'
import { fallbackVerdict, modelVerdict, ruleVerdict, SHOW_THRESHOLD, suggestionState } from './rules'

const me = 'user-1'

test('a Gmail message keeps its subject and reads labels', () => {
  const mail = gmailNotification(me, { messageId: 'm1', threadId: 't1', subject: 'Thursday agenda', sender: 'Dana <dana@acme.com>', labelIds: ['INBOX', 'IMPORTANT'], messageTimestamp: '1761200000000', messageText: 'Can you add the budget item?' })!
  assert.equal(mail.title, 'Thursday agenda')
  assert.equal(mail.action, 'reply')
  assert.equal(mail.direct, true)
  assert.equal(mail.automated, false)
  assert.equal(mail.url, 'https://mail.google.com/mail/u/0/#all/t1')
  assert.equal(mail.occurredAt.getTime(), 1761200000000)
  const promo = gmailNotification(me, { message_id: 'm2', subject: 'Sale', sender: 'shop <no-reply@shop.com>', label_ids: 'INBOX,CATEGORY_PROMOTIONS' })!
  assert.equal(promo.automated, true)
  assert.equal(gmailNotification(me, { subject: 'no id' }), null)
})

test('Composio events route by toolkit', () => {
  const dm = composioNotification({ userId: me, toolkitSlug: 'SLACK', payload: { channel: 'D123', ts: '1761200000.0001', text: 'are you around?', user: 'U9' } })!
  assert.equal(dm.source, 'slack')
  assert.equal(dm.direct, true)
  assert.equal(dm.title, 'are you around?')
  assert.equal(dm.externalId, 'D123:1761200000.0001')
  assert.equal(slackNotification(me, { channel: 'C1', ts: '1', text: 'deploy done', bot_id: 'B1' })!.automated, true)
  assert.equal(composioNotification({ userId: me, toolkitSlug: 'github', payload: {} }), null)
})

test('Linear: an issue assigned to me by someone else is required', () => {
  const recipient = { userId: me, linearUserId: 'lin-me' }
  const payload = { type: 'Issue', action: 'update', webhookTimestamp: 1, url: 'https://linear.app/x/issue/MIK-9', actor: { id: 'lin-dana', name: 'Dana', type: 'user' }, updatedFrom: { assigneeId: null }, data: { id: 'i1', identifier: 'MIK-9', title: 'Fix login', assigneeId: 'lin-me', updatedAt: '2026-10-23T10:00:00Z' } }
  const issue = linearIssueNotification(recipient, payload)!
  assert.equal(issue.required, true)
  assert.equal(issue.title, 'Fix login')
  assert.equal(issue.fromSelf, false)
  assert.equal(linearIssueNotification(recipient, { ...payload, updatedFrom: { title: 'old' } }), null)
  assert.equal(linearIssueNotification(recipient, { ...payload, data: { ...payload.data, assigneeId: 'lin-other' } }), null)
  const comment = linearCommentNotification(recipient, { type: 'Comment', action: 'create', actor: { id: 'lin-me' }, data: { id: 'c1', body: 'done', userId: 'lin-me', issue: { title: 'Fix login' } } })!
  assert.equal(comment.fromSelf, true)
})

test('GitHub: review requests and replies on my PRs', () => {
  const recipient = { userId: me, githubId: '42' }
  const base = { repository: { full_name: 'a/b' }, sender: { id: 7, login: 'dana', type: 'User' } }
  const review = { ...base, action: 'review_requested', requested_reviewer: { id: 42 }, pull_request: { number: 73, title: 'Add briefing', html_url: 'https://github.com/a/b/pull/73', updated_at: '2026-10-23T10:00:00Z', user: { id: 7 } } }
  assert.deepEqual(githubCandidateIds('pull_request', review), ['42'])
  const pr = githubNotification(recipient, 'pull_request', review)!
  assert.equal(pr.action, 'review')
  assert.equal(pr.required, true)
  assert.equal(pr.title, 'Add briefing')
  assert.equal(githubNotification({ ...recipient, githubId: '8' }, 'pull_request', review), null)
  const changes = githubNotification(recipient, 'pull_request_review', { ...base, action: 'submitted', review: { id: 5, state: 'changes_requested', body: 'see notes' }, pull_request: { number: 73, title: 'Add briefing', user: { id: 42 } } })!
  assert.equal(changes.required, true)
  const bot = githubNotification(recipient, 'issue_comment', { ...base, sender: { id: 9, type: 'Bot' }, action: 'created', issue: { number: 1, title: 'x', user: { id: 42 } }, comment: { id: 3, body: 'CI passed' } })!
  assert.equal(bot.automated, true)
})

test('GitHub signatures are checked against the raw body', () => {
  const body = '{"zen":"hi"}'
  const signature = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`
  assert.equal(verifyGitHubSignature(body, signature, 's3cret'), true)
  assert.equal(verifyGitHubSignature(body, signature, 'other'), false)
  assert.equal(verifyGitHubSignature(body, null, 's3cret'), false)
})

const notification = (fields: Partial<ExternalNotification>): ExternalNotification => ({ userId: me, source: 'gmail', externalId: 'x', action: 'reply', title: 't', url: null, actor: null, occurredAt: new Date(), required: false, direct: false, fromSelf: false, automated: false, excerpt: '', ...fields })

test('rules decide the clear cases and leave the rest to the model', () => {
  assert.deepEqual(ruleVerdict(notification({ fromSelf: true, required: true })), { shown: false, decidedBy: 'rule', probability: null })
  assert.deepEqual(ruleVerdict(notification({ automated: true })), { shown: false, decidedBy: 'rule', probability: null })
  assert.deepEqual(ruleVerdict(notification({ required: true })), { shown: true, decidedBy: 'rule', probability: null })
  assert.equal(ruleVerdict(notification({ direct: true })), null)
  assert.equal(modelVerdict(SHOW_THRESHOLD).shown, true)
  assert.equal(modelVerdict(0.2).shown, false)
  assert.equal(fallbackVerdict(notification({ direct: true })).shown, true)
  assert.equal(fallbackVerdict(notification({})).shown, false)
  assert.equal(suggestionState(notification({ excerpt: 'body' })).content, 'body')
})

test('the briefing names required items first and counts by source', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 8, minutes))
  const content = briefingContent([
    { id: 'a', source: 'gmail', action: 'reply', required: false, probability: 0.9, occurredAt: at(1) },
    { id: 'b', source: 'github', action: 'review', required: true, probability: null, occurredAt: at(0) },
    { id: 'c', source: 'gmail', action: 'reply', required: false, probability: 0.6, occurredAt: at(5) },
    { id: 'd', source: 'slack', action: 'reply', required: false, probability: 0.6, occurredAt: at(2) },
  ])
  assert.deepEqual(content.highlights, ['b', 'a', 'c'])
  assert.deepEqual(content.counts, { gmail: 2, github: 1, slack: 1 })
  assert.equal(content.total, 4)
})

test('local dates follow the person\'s time zone', () => {
  const now = new Date('2026-10-23T02:00:00Z')
  assert.equal(localDate('America/New_York', now), '2026-10-22')
  assert.equal(localDate('Asia/Shanghai', now), '2026-10-23')
  assert.equal(safeTimeZone('Not/AZone'), 'UTC')
  assert.equal(safeTimeZone(null), 'UTC')
})
