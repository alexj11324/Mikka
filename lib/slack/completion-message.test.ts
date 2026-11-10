import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '@/lib/base-path'
import {
  SLACK_COMPLETION_MAX,
  slackCompletionDeepLink,
  slackCompletionLocale,
  slackCompletionMessage,
  type SlackCompletionInput,
  type SlackRunStatus,
} from './completion-message'

const ISSUE = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const LINK = slackCompletionDeepLink({ issue: ISSUE, thread: THREAD, origin: 'https://app.example.com', basePath: '/mikka' })
const base: SlackCompletionInput = {
  identifier: 'MIK-42',
  title: 'Fix login redirect',
  status: 'succeeded',
  deepLink: LINK,
  locale: 'en',
}
const head = (text: string) => text.split('\n')[0]
const linkLine = (text: string) => text.slice(text.indexOf('\n') + 1)

test('the exact template carries the identifier, title, fixed status and deep link', () => {
  const text = slackCompletionMessage(base)
  assert.equal(text, `Mikka: MIK-42 Fix login redirect — Done\n${LINK}`)
  assert.equal(linkLine(text), LINK)
  // The link is workspaceLink plus the app origin and base path, not a
  // hand-built query string.
  assert.equal(LINK, `https://app.example.com${withBasePath(workspaceLink({ issue: ISSUE, thread: THREAD }), '/mikka')}`)
  const url = new URL(LINK)
  assert.equal(url.searchParams.get('issue'), ISSUE)
  assert.equal(url.searchParams.get('thread'), THREAD)
  assert.equal(url.href.includes('Fix login redirect'), false, 'the link carries opaque ids only')
})

test('all four statuses are fixed copy in English and Chinese', () => {
  const copy: Array<[SlackRunStatus, string, string]> = [
    ['succeeded', 'Done', '完成'],
    ['failed', 'Failed', '失败'],
    ['stopped', 'Stopped', '已停止'],
    ['cancelled', 'Cancelled', '已取消'],
  ]
  for (const [status, en, zh] of copy) {
    assert.equal(head(slackCompletionMessage({ ...base, status, locale: 'en' })), `Mikka: MIK-42 Fix login redirect — ${en}`)
    assert.equal(head(slackCompletionMessage({ ...base, status, locale: 'zh-CN' })), `Mikka: MIK-42 Fix login redirect — ${zh}`)
  }
})

test('the person locale drives the copy; missing or unknown falls back to English', () => {
  assert.equal(slackCompletionLocale(undefined), 'en')
  assert.equal(slackCompletionLocale(null), 'en')
  assert.equal(slackCompletionLocale('fr'), 'en')
  assert.equal(slackCompletionLocale('zh-CN'), 'zh-CN')
  assert.equal(head(slackCompletionMessage({ ...base, locale: undefined })), 'Mikka: MIK-42 Fix login redirect — Done')
  assert.equal(head(slackCompletionMessage({ ...base, locale: 'zh-CN' })), 'Mikka: MIK-42 Fix login redirect — 完成')
})

test('a long title shrinks to the 400-character budget; the link is byte-for-byte intact', () => {
  const text = slackCompletionMessage({ ...base, title: 'Fix login redirect '.repeat(80) })
  const length = Array.from(text).length
  assert.ok(length <= SLACK_COMPLETION_MAX, `${length} code points`)
  assert.equal(linkLine(text), LINK)
  assert.match(head(text), /^Mikka: MIK-42 Fix login redirect /)
  assert.match(head(text), /… — Done$/, 'the title gives way with an ellipsis')
  assert.equal(text.split('\n').length, 2)
})

test('the identifier survives title truncation', () => {
  const text = slackCompletionMessage({ ...base, title: 'x'.repeat(2_000) })
  assert.ok(Array.from(text).length <= SLACK_COMPLETION_MAX)
  assert.match(head(text), /^Mikka: MIK-42 /)
})

test('title truncation never splits a surrogate pair', () => {
  const text = slackCompletionMessage({ ...base, identifier: null, title: '😀'.repeat(300) })
  assert.equal(/\p{Cs}/u.test(text), false, 'no lone surrogate')
  assert.ok(Array.from(text).length <= SLACK_COMPLETION_MAX)
  assert.match(head(text), /… — Done$/)
  assert.equal(linkLine(text), LINK)
})

test('a link that fills the budget drops the label and stays whole', () => {
  const longLink = `https://app.example.com/${'a'.repeat(366)}` // 390 code points
  const text = slackCompletionMessage({ ...base, deepLink: longLink })
  assert.equal(text, longLink)
  assert.equal(text.includes('Done'), false, 'the status label is dropped')
  assert.ok(Array.from(text).length <= SLACK_COMPLETION_MAX)
})

test('a link longer than the whole budget is returned alone, never truncated', () => {
  const huge = `https://app.example.com/${'a'.repeat(476)}` // 500 code points
  const text = slackCompletionMessage({ ...base, deepLink: huge })
  assert.equal(text, huge)
  assert.equal(text.includes('Done'), false)
})

test('control characters are removed from display text', () => {
  const text = slackCompletionMessage({ ...base, identifier: 'MIK\u0000-42', title: 'Fix\u001bthe\u0007issue' })
  assert.equal(/[\p{Cc}]/u.test(head(text)), false)
  assert.match(head(text), /^Mikka: MIK -42 Fix the issue — Done$/)
})

test('an absent identifier or title is omitted without leaving double spaces', () => {
  assert.equal(head(slackCompletionMessage({ ...base, identifier: null })), 'Mikka: Fix login redirect — Done')
  assert.equal(head(slackCompletionMessage({ ...base, title: '   ' })), 'Mikka: MIK-42 — Done')
  assert.equal(head(slackCompletionMessage({ ...base, identifier: null, title: null })), 'Mikka: your run — Done')
  assert.equal(
    head(slackCompletionMessage({ ...base, identifier: null, title: null, locale: 'zh-CN' })),
    'Mikka: 你的任务 — 完成',
  )
})

test('task text cannot open a second line or forge the link line', () => {
  const text = slackCompletionMessage({
    ...base,
    identifier: 'MIK-42\nMikka: forged',
    title: 'line one\r\nline two\thttps://evil.example',
  })
  assert.equal(text.split('\n').length, 2)
  assert.equal(linkLine(text), LINK)
  assert.equal(head(text).includes('https://evil.example'), true, 'the title is flattened, not executed as a line')
})

test('prompt, report, error, stop reason and failure details never reach the message', () => {
  const extra = {
    prompt: 'PROMPT_SECRET',
    report: { summary: 'REPORT_SECRET' },
    error: 'ERROR_SECRET',
    failureDetails: 'DETAIL_SECRET',
    stopReason: 'STOP_SECRET',
    outcomeReason: 'OUTCOME_SECRET',
  }
  const text = slackCompletionMessage({ ...base, ...extra } as SlackCompletionInput)
  for (const secret of ['PROMPT_SECRET', 'REPORT_SECRET', 'ERROR_SECRET', 'DETAIL_SECRET', 'STOP_SECRET', 'OUTCOME_SECRET']) {
    assert.equal(text.includes(secret), false, secret)
  }
})

test('a status outside the fixed four and a non-http link are refused', () => {
  assert.throws(() => slackCompletionMessage({ ...base, status: 'provider_failure' as SlackRunStatus }), /unknown run status/)
  assert.throws(() => slackCompletionMessage({ ...base, deepLink: 'https://app.example.com/\nhttps://evil.example' }), /deep link/)
  assert.throws(() => slackCompletionMessage({ ...base, deepLink: 'javascript:alert(1)' }), /deep link/)
  assert.throws(() => slackCompletionMessage({ ...base, deepLink: '   ' }), /deep link/)
})

test('the deep link helper applies the injected origin and base path', () => {
  assert.equal(
    slackCompletionDeepLink({ issue: ISSUE, thread: THREAD, origin: 'https://app.example.com/', basePath: '/mikka' }),
    `https://app.example.com${withBasePath(workspaceLink({ issue: ISSUE, thread: THREAD }), '/mikka')}`,
  )
  assert.equal(
    slackCompletionDeepLink({ issue: ISSUE, thread: THREAD, origin: 'https://app.example.com', basePath: '' }),
    `https://app.example.com${workspaceLink({ issue: ISSUE, thread: THREAD })}`,
  )
  assert.throws(
    () => slackCompletionDeepLink({ issue: ISSUE, thread: THREAD, origin: 'https://app.example.com/mikka' }),
    /origin/,
  )
  assert.throws(
    () => slackCompletionDeepLink({ issue: ISSUE, thread: THREAD, origin: 'file:///tmp/app' }),
    /origin/,
  )
})
