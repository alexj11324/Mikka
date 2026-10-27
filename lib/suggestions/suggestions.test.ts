import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { actionLocale, actionTitlePrompt, clampTitle, displayTitle, parseActionTitles } from './action-title'
import { briefingContent, localDate, safeTimeZone } from './briefing'
import { verifyGitHubSignature } from './github-webhook'
import { composioNotification, githubCandidateIds, githubNotification, gmailNotification, linearCommentNotification, linearIssueNotification, slackNotification } from './notification'
import { missingTriggers, needsConfig, triggerSlugs } from './triggers'

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

test('notices about one thread share a matter', () => {
  const first = gmailNotification(me, { messageId: 'm1', threadId: 't1', subject: 'Invoice' })!
  const second = gmailNotification(me, { messageId: 'm2', threadId: 't1', subject: 'Re: Invoice' })!
  assert.equal(first.matterKey, 'gmail:t1')
  assert.equal(second.matterKey, first.matterKey)
  assert.equal(slackNotification(me, { channel: 'C1', ts: '2', thread_ts: '1', text: 'still failing' })!.matterKey, 'slack:C1:1')
  const recipient = { userId: me, githubId: '42' }
  const comment = githubNotification(recipient, 'issue_comment', { repository: { full_name: 'a/b' }, sender: { id: 7 }, action: 'created', issue: { number: 9, title: 'x', user: { id: 42 } }, comment: { id: 3, body: 'ping' } })!
  assert.equal(comment.matterKey, 'github:a/b#9')
  assert.equal(linearCommentNotification({ userId: me, linearUserId: 'lin-me' }, { type: 'Comment', action: 'create', data: { id: 'c1', body: 'hi', issueId: 'i1' } })!.matterKey, 'linear:i1')
})

test('the briefing names the highest levels first and counts by source', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 8, minutes))
  const content = briefingContent([
    { id: 'a', source: 'gmail', action: 'reply', required: false, level: 'high', probability: null, occurredAt: at(1) },
    { id: 'b', source: 'github', action: 'review', required: true, level: 'normal', probability: null, occurredAt: at(0) },
    { id: 'c', source: 'gmail', action: 'reply', required: false, level: 'critical', probability: null, occurredAt: at(5) },
    // A row from before the levels ranks as normal by its old probability.
    { id: 'd', source: 'slack', action: 'reply', required: false, level: null, probability: 0.9, occurredAt: at(2) },
  ])
  assert.deepEqual(content.highlights, ['c', 'a', 'd'])
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

test('action lines (R-41): the prompt carries the rule and examples, the answer is checked, and the raw title is the fallback', () => {
  const items = [
    { id: 's1', source: 'gmail', action: 'reply', title: 'Re: Thursday', actor: 'Kevin', excerpt: 'Can we move Thursday to Wednesday? Need to know by noon tomorrow.' },
    { id: 's2', source: 'github', action: 'review', title: 'Fix types', actor: 'dana', excerpt: 'Fix types' },
  ]
  const zh = actionTitlePrompt(items, 'zh-CN')
  assert.match(zh.instructions, /Simplified Chinese, at most 30 characters/)
  assert.match(zh.instructions, /Start with a verb/)
  assert.match(zh.instructions, /「回复 Kevin：周四的会改到周三，明天中午前要定」/)
  assert.match(zh.instructions, /Bad: 「CI 挂了」/)
  assert.match(zh.instructions, /untrusted evidence/)
  const sent = JSON.parse(zh.prompt).notifications
  assert.equal(sent[0].text, items[0].excerpt)
  assert.equal(sent[1].text, undefined, 'an excerpt that only repeats the title is not sent')
  assert.match(actionTitlePrompt(items, 'en').instructions, /English, at most 60 characters/)

  const answer = 'Sure: {"titles": [{"id": "s1", "title": "回复 Kevin：周四的会改到周三，明天中午前要定"}, {"id": "s9", "title": "x"}, {"id": "s2", "title": "  "}]}'
  assert.deepEqual([...parseActionTitles(answer, ['s1', 's2'], 'zh-CN')], [['s1', '回复 Kevin：周四的会改到周三，明天中午前要定']])
  assert.equal(parseActionTitles('not json', ['s1'], 'zh-CN').size, 0)
  assert.equal(parseActionTitles('{"titles": "no"}', ['s1'], 'zh-CN').size, 0)
  const long = parseActionTitles(JSON.stringify({ titles: [{ id: 's1', title: '回'.repeat(40) }] }), ['s1'], 'zh-CN').get('s1')!
  assert.equal([...long].length, 30)
  assert.ok(long.endsWith('…'))
  assert.equal(clampTitle('a'.repeat(70), 'en').length, 60)

  assert.equal(displayTitle({ title: 'Re: Thursday', actionTitle: '回复 Kevin：改到周三' }), '回复 Kevin：改到周三')
  assert.equal(displayTitle({ title: 'Re: Thursday', actionTitle: null }), 'Re: Thursday')
  assert.equal(displayTitle({ title: 'Re: Thursday', actionTitle: ' ' }), 'Re: Thursday')
  assert.equal(actionLocale('en'), 'en')
  assert.equal(actionLocale(null), 'zh-CN')
})
