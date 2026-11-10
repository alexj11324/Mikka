import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commentIdForRun,
  LINEAR_RUN_STATUS_TEXT,
  linearRunCommentBody,
  linearRunDeepLink,
  RUN_COMMENT_TITLE_MAX,
  type LinearRunCommentInput,
} from './run-comment'

const ISSUE = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const ORIGIN = 'https://app.example.com'
const DEEP_LINK = `${ORIGIN}/mikka?issue=${ISSUE}&thread=${RUN}`

test('the four terminal statuses render in English and Chinese', () => {
  const cases = [
    ['succeeded', 'Done', '完成'],
    ['failed', 'Failed', '失败'],
    ['stopped', 'Stopped', '已停止'],
    ['cancelled', 'Cancelled', '已取消'],
  ] as const
  for (const [status, en, zh] of cases) {
    assert.equal(LINEAR_RUN_STATUS_TEXT[status].en, en)
    assert.equal(LINEAR_RUN_STATUS_TEXT[status]['zh-CN'], zh)
    assert.equal(
      linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status, locale: 'en', deepLink: DEEP_LINK }),
      `Mikka: MIK-42 Fix login redirect — ${en}\n[Open in Mikka](${DEEP_LINK})`,
    )
    assert.equal(
      linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status, locale: 'zh-CN', deepLink: DEEP_LINK }),
      `Mikka: MIK-42 Fix login redirect — ${zh}\n[Open in Mikka](${DEEP_LINK})`,
    )
  }
})

test('a long title is truncated onto one line while the deep link stays whole', () => {
  const title = `${'A'.repeat(400)}\nsecond line`
  const body = linearRunCommentBody({ identifier: 'MIK-42', title, status: 'succeeded', locale: 'en', deepLink: DEEP_LINK })
  const [header, link, ...rest] = body.split('\n')
  assert.deepEqual(rest, [], 'the body is exactly two lines')
  assert.equal(link, `[Open in Mikka](${DEEP_LINK})`, 'the link is never truncated')
  assert.ok(header.endsWith(' — Done'))
  const rendered = Array.from(header.slice('Mikka: MIK-42 '.length, header.length - ' — Done'.length))
  assert.ok(rendered.length <= RUN_COMMENT_TITLE_MAX, `${rendered.length} title code points`)
  assert.ok(rendered.at(-1) === '…', 'truncation is visible')
  assert.ok(rendered.slice(0, -1).every(point => point === 'A'), 'no second-line text or other fields leak in')
})

test('only the five named fields reach the comment; failure detail fields never do', () => {
  const forbidden = ['device_lost', 'E_SECRET_ERROR', 'SECRET_DETAIL', 'SECRET_REPORT', 'SECRET_OUTCOME', 'SECRET_PROMPT', 'SECRET_INSTRUCTIONS']
  const input = {
    identifier: 'MIK-42', title: 'Visible title', status: 'failed' as const, locale: 'en' as const, deepLink: DEEP_LINK,
    stopReason: 'device_lost', error: 'E_SECRET_ERROR', failureDetails: { message: 'SECRET_DETAIL' },
    report: { summary: 'SECRET_REPORT' }, outcomeReason: 'SECRET_OUTCOME', prompt: 'SECRET_PROMPT',
    agentDefinition: { instructions: 'SECRET_INSTRUCTIONS' },
  } as unknown as LinearRunCommentInput
  const body = linearRunCommentBody(input)
  assert.equal(body, `Mikka: MIK-42 Visible title — Failed\n[Open in Mikka](${DEEP_LINK})`)
  for (const value of forbidden) assert.ok(!body.includes(value), value)
})

test('the body falls back to a generic subject when the task has no identifier or title', () => {
  assert.equal(
    linearRunCommentBody({ identifier: '', title: '', status: 'cancelled', locale: 'en', deepLink: DEEP_LINK }),
    `Mikka: your run — Cancelled\n[Open in Mikka](${DEEP_LINK})`,
  )
})

test('an unsupported status is refused instead of rendered', () => {
  assert.throws(
    () => linearRunCommentBody({ identifier: 'MIK-42', title: 'x', status: 'paused' as never, locale: 'en', deepLink: DEEP_LINK }),
    /Unsupported Linear run status/,
  )
})

test('the comment id is a stable RFC 4122 UUID per run', () => {
  const id = commentIdForRun(RUN)
  assert.equal(id, 'd8e3074c-5a64-5946-ae8b-9401b36787c8', 'pins the SHA-256 prefix, version and variant')
  assert.equal(id, commentIdForRun(RUN), 'retries of one run share one id')
  assert.notEqual(id, commentIdForRun(ISSUE), 'different runs never collide')
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('the deep link carries only opaque ids, prefixing origin and base path', () => {
  assert.equal(
    linearRunDeepLink({ issueId: ISSUE, runId: RUN, origin: ORIGIN, basePath: '/mikka' }),
    DEEP_LINK,
  )
  assert.equal(
    linearRunDeepLink({ issueId: ISSUE, runId: RUN, origin: `${ORIGIN}/`, basePath: '' }),
    `${ORIGIN}/?issue=${ISSUE}&thread=${RUN}`,
  )
  assert.equal(
    linearRunDeepLink({ issueId: null, runId: RUN, origin: ORIGIN, basePath: '' }),
    `${ORIGIN}/?thread=${RUN}`,
    'an issue-less run still links only its thread id',
  )
  const link = linearRunDeepLink({ issueId: ISSUE, runId: RUN, origin: ORIGIN, basePath: '/mikka' })
  assert.ok(!link.includes('Fix login redirect'))
  assert.ok(!link.includes('MIK-42'))
})
