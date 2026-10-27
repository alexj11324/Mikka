import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { BRIEFING_HOUR, briefingContent, dueBriefingZones, localClock, localDate, localInstant, safeTimeZone } from './briefing'
import { verifyGitHubSignature } from './github-webhook'
import { composioNotification, githubCandidateIds, githubNotification, gmailNotification, linearCommentNotification, linearIssueNotification, notionNotification, notionSearchNotification, slackNotification, slackSearchNotification, type ExternalNotification } from './notification'
import { missingTriggers, needsConfig, triggerSlugs } from './triggers'
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

test('triggers are picked from Composio\'s catalog', () => {
  const catalog = [
    { slug: 'NOTION_PAGE_ADDED_TRIGGER', config: { properties: {}, required: [] } },
    { slug: 'NOTION_PAGE_UPDATED_TRIGGER', config: { properties: { page_id: { type: 'string' } }, required: ['page_id'] } },
    { slug: 'NOTION_COMMENTS_ADDED_TRIGGER', config: { properties: { interval: { default: 1 } }, required: ['interval'] } },
    { slug: 'NOTION_DATA_SOURCE_SCHEMA_UPDATED', config: {} },
  ]
  assert.deepEqual(triggerSlugs('notion', catalog), ['NOTION_PAGE_ADDED_TRIGGER', 'NOTION_COMMENTS_ADDED_TRIGGER'])
  assert.deepEqual(triggerSlugs('gmail', [{ slug: 'GMAIL_NEW_GMAIL_MESSAGE' }, { slug: 'GMAIL_EMAIL_SENT_TRIGGER' }]), ['GMAIL_NEW_GMAIL_MESSAGE'])
  assert.deepEqual(triggerSlugs('github', [{ slug: 'GITHUB_COMMIT_EVENT' }]), [])
  assert.equal(needsConfig({ slug: 'x', config: { required: ['page_id'], properties: {} } }), true)
})

test('only missing triggers are created, so a re-check is safe', () => {
  const wanted = [{ connectedAccountId: 'a1', slug: 'GMAIL_NEW_GMAIL_MESSAGE' }, { connectedAccountId: 'a2', slug: 'NOTION_PAGE_ADDED_TRIGGER' }]
  assert.deepEqual(missingTriggers(wanted, [{ connectedAccountId: 'a1', triggerName: 'GMAIL_NEW_GMAIL_MESSAGE', disabledAt: null }]), [wanted[1]])
  assert.deepEqual(missingTriggers(wanted, [{ connectedAccountId: 'a1', triggerName: 'GMAIL_NEW_GMAIL_MESSAGE', disabledAt: '2026-10-23T00:00:00Z' }]), wanted)
})

test('08:00 local is found across offsets and DST changes', () => {
  assert.equal(localInstant('Asia/Shanghai', '2026-10-27', 8).toISOString(), '2026-10-27T00:00:00.000Z')
  assert.equal(localInstant('America/Los_Angeles', '2026-10-27', 8).toISOString(), '2026-10-27T15:00:00.000Z')
  // The day after US clocks go back: PST, not PDT.
  assert.equal(localInstant('America/Los_Angeles', '2026-11-02', 8).toISOString(), '2026-11-02T16:00:00.000Z')
  assert.equal(localInstant('Asia/Kolkata', '2026-10-27', 8).toISOString(), '2026-10-27T02:30:00.000Z')
  assert.equal(localInstant('not/a zone', '2026-10-27', 8).toISOString(), '2026-10-27T08:00:00.000Z')
  assert.deepEqual(localClock('Asia/Shanghai', new Date('2026-10-26T23:59:00Z')), { date: '2026-10-27', hour: 7 })
  assert.deepEqual(localClock('UTC', new Date('2026-10-27T00:30:00Z')), { date: '2026-10-27', hour: 0 })
})

test('a time zone is due from 08:00 until its local midnight', () => {
  const zones = ['Asia/Shanghai', 'Europe/Berlin', 'America/New_York']
  // 00:10 UTC: 08:10 in Shanghai, 01:10 in Berlin, 20:10 the day before in New York.
  const due = dueBriefingZones(zones, new Date('2026-10-27T00:10:00Z'))
  assert.deepEqual(due.map(zone => [zone.timeZone, zone.localDate]), [['Asia/Shanghai', '2026-10-27'], ['America/New_York', '2026-10-26']])
  assert.equal(due[0].dueAt.toISOString(), '2026-10-27T00:00:00.000Z')
  // 07:59 in Shanghai is not due yet.
  assert.deepEqual(dueBriefingZones(['Asia/Shanghai'], new Date('2026-10-26T23:59:00Z')), [])
  assert.equal(BRIEFING_HOUR, 8)
})

test('search results keep the external id their trigger event has', () => {
  const event = slackNotification(me, { channel: 'D123', ts: '1761200000.0001', text: 'are you around?', user: 'U9' })!
  const match = slackSearchNotification(me, { channel: { id: 'D123', name: 'U9' }, ts: '1761200000.0001', text: 'are you around?', user: 'U9', permalink: 'https://x.slack.com/p1' })!
  assert.equal(match.externalId, event.externalId)
  assert.equal(match.direct, true)
  const page = { object: 'page', id: 'p-1', url: 'https://notion.so/p-1', last_edited_time: '2026-10-27T08:00:00.000Z', last_edited_by: { object: 'user', id: 'u1' }, properties: { Name: { id: 'title', type: 'title', title: [{ plain_text: 'Q4 ' }, { plain_text: 'plan' }] } } }
  const notion = notionSearchNotification(me, page)!
  assert.equal(notion.title, 'Q4 plan')
  assert.equal(notion.externalId, notionNotification(me, { page_id: 'p-1', title: 'Q4 plan', last_edited_time: '2026-10-27T08:00:00.000Z' })!.externalId)
  assert.equal(notionSearchNotification(me, { ...page, in_trash: true }), null)
  assert.equal(notionSearchNotification(me, { ...page, object: 'database' }), null)
})
