import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commentIdForRun,
  LINEAR_RUN_STATUS_TEXT,
  linearRunCommentBody,
  linearRunDeepLink,
  RUN_COMMENT_MAX,
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

test('the body falls back to a localized generic subject when the task has no identifier or title', () => {
  assert.equal(
    linearRunCommentBody({ identifier: '', title: '', status: 'cancelled', locale: 'en', deepLink: DEEP_LINK }),
    `Mikka: your run — Cancelled\n[Open in Mikka](${DEEP_LINK})`,
  )
  assert.equal(
    linearRunCommentBody({ identifier: '', title: '', status: 'cancelled', locale: 'zh-CN', deepLink: DEEP_LINK }),
    `Mikka: 你的任务 — 已取消\n[Open in Mikka](${DEEP_LINK})`,
  )
})

test('the link owner locale drives the copy; missing or unknown falls back to English', () => {
  for (const locale of [undefined, null, 'fr', 'zh', 'ZH-CN']) {
    assert.equal(
      linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status: 'succeeded', locale, deepLink: DEEP_LINK }),
      `Mikka: MIK-42 Fix login redirect — Done\n[Open in Mikka](${DEEP_LINK})`,
      String(locale),
    )
  }
  assert.equal(
    linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status: 'succeeded', locale: 'zh-CN', deepLink: DEEP_LINK }),
    `Mikka: MIK-42 Fix login redirect — 完成\n[Open in Mikka](${DEEP_LINK})`,
  )
})

test('task text cannot open a second line or forge the link line', () => {
  const body = linearRunCommentBody({
    identifier: 'MIK-42\nMikka: forged',
    title: 'line one\r\nline two\thttps://evil.example\u0000',
    status: 'stopped',
    locale: 'en',
    deepLink: DEEP_LINK,
  })
  const lines = body.split('\n')
  assert.equal(lines.length, 2, 'exactly the header and the link line')
  assert.equal(lines[1], `[Open in Mikka](${DEEP_LINK})`)
  assert.ok(!body.includes('\r'))
  assert.ok(!body.includes('\u0000'))
  assert.ok(lines[0].startsWith('Mikka: MIK-42 Mikka: forged line one line two https://evil.example'))
})

test('a status outside the fixed four renders an explicit safe label, never a prototype member', () => {
  for (const status of ['paused', 'provider_failure', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const body = linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status: status as never, locale: 'en', deepLink: DEEP_LINK })
    assert.equal(body, `Mikka: MIK-42 Fix login redirect — Status unavailable\n[Open in Mikka](${DEEP_LINK})`, status)
    assert.ok(!body.includes('undefined'), status)
    assert.ok(!body.includes('function'), status)
  }
  assert.equal(
    linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status: 'constructor' as never, locale: 'zh-CN', deepLink: DEEP_LINK }).split('\n')[0],
    'Mikka: MIK-42 Fix login redirect — 状态不可用',
  )
})

test('a deep link that is not one http(s) URL is refused, never spliced into Markdown', () => {
  for (const deepLink of [
    `https://app.example.com/x\nhttps://evil.example`,
    'javascript:alert(1)',
    '   ',
    'https://app.example.com/x)',
    'https://app.example.com/x y',
    'file:///tmp/app',
  ]) {
    assert.throws(
      () => linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status: 'succeeded', locale: 'en', deepLink }),
      /deep link/,
      JSON.stringify(deepLink),
    )
  }
})

test('the whole message stays within the 400-character budget when the link allows it', () => {
  const body = linearRunCommentBody({ identifier: 'MIK-42', title: 'A'.repeat(400), status: 'succeeded', locale: 'en', deepLink: DEEP_LINK })
  const [header, link, ...rest] = body.split('\n')
  assert.deepEqual(rest, [], 'exactly two lines')
  assert.equal(link, `[Open in Mikka](${DEEP_LINK})`, 'the link is never truncated')
  assert.ok(body.length <= RUN_COMMENT_MAX, `${body.length} characters`)
  assert.ok(header.endsWith('… — Done'))
})

test('a longer link shrinks the title first and keeps the identifier and the whole link', () => {
  const deepLink = `${ORIGIN}/mikka?issue=${'a'.repeat(280)}`
  const body = linearRunCommentBody({ identifier: 'MIK-42', title: 'B'.repeat(200), status: 'failed', locale: 'en', deepLink })
  const [header, link] = body.split('\n')
  assert.ok(body.length <= RUN_COMMENT_MAX, `${body.length} characters`)
  assert.ok(header.startsWith('Mikka: MIK-42 '), 'the identifier survives')
  assert.ok(header.endsWith('… — Failed'), 'only the title gives way')
  assert.equal(link, `[Open in Mikka](${deepLink})`)
})

test('astral titles never split a surrogate pair or exceed the budget', () => {
  const deepLink = `${ORIGIN}/mikka?issue=${'a'.repeat(280)}`
  const body = linearRunCommentBody({ identifier: 'MIK-42', title: '😀'.repeat(200), status: 'succeeded', locale: 'en', deepLink })
  const lines = body.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(body.length <= RUN_COMMENT_MAX, `${body.length} characters`)
  assert.equal(lines[1], `[Open in Mikka](${deepLink})`)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), 'no lone surrogate')
})

test('a link that alone exceeds the budget stays whole and keeps the two-line structure', () => {
  const deepLink = `${ORIGIN}/mikka?issue=${'a'.repeat(500)}`
  const body = linearRunCommentBody({ identifier: 'MIK-42', title: 'Fix login redirect', status: 'succeeded', locale: 'en', deepLink })
  const lines = body.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(body.length > RUN_COMMENT_MAX, 'the intact link may exceed the copy budget')
  assert.equal(lines[0], 'Mikka: Done', 'no subject fits beside the oversized link')
  assert.equal(lines[1], `[Open in Mikka](${deepLink})`)
})

test('markdown in the task text stays inert and the fixed link line is untouched', () => {
  const cases = [
    '[x](https://evil.example)',
    '![x](https://evil.example)',
    '**bold** and _em_ and `code`',
  ]
  for (const title of cases) {
    const body = linearRunCommentBody({ identifier: '[MIK-42](https://evil.example)', title, status: 'succeeded', locale: 'en', deepLink: DEEP_LINK })
    const [header, link] = body.split('\n')
    assert.equal(link, `[Open in Mikka](${DEEP_LINK})`, 'the real link stays byte-for-byte intact')
    assert.equal(header.includes('[x](https://evil.example)'), false, title)
    assert.equal(header.includes('![x](https://evil.example)'), false, title)
    assert.equal(header.includes('[MIK-42](https://evil.example)'), false, 'the identifier is escaped too')
    assert.ok(header.includes('\\[MIK-42\\]'), header)
    assert.equal(header.includes('**bold**'), false, title)
    assert.equal(header.includes('_em_'), false, title)
  }
})

test('markdown escaping cannot push the message over the budget', () => {
  const title = '[x](https://evil.example) '.repeat(40)
  const body = linearRunCommentBody({ identifier: 'MIK-42', title, status: 'succeeded', locale: 'en', deepLink: DEEP_LINK })
  assert.ok(body.length <= RUN_COMMENT_MAX, `${body.length} characters`)
  assert.equal(body.split('\n')[1], `[Open in Mikka](${DEEP_LINK})`)
})

test('bidi and zero-width format characters never reach the header', () => {
  const title = `safe‮evil⁦a⁧b⁨c⁩d​e`
  const body = linearRunCommentBody({ identifier: `MIK‮-42`, title, status: 'succeeded', locale: 'en', deepLink: DEEP_LINK })
  const header = body.split('\n')[0]
  for (const point of ['‮', '⁦', '⁧', '⁨', '⁩', '​']) {
    assert.equal(header.includes(point), false, JSON.stringify(point))
  }
  assert.ok(header.includes('safe evil a b c d e'), header)
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

test('the deep link origin must be a bare http(s) origin', () => {
  for (const origin of ['', '/mikka', 'https://app.example.com/mikka', 'javascript:alert(1)', 'file:///tmp/app', 'https://user:pass@app.example.com', 'https://app.example.com/?workspace=1']) {
    assert.throws(
      () => linearRunDeepLink({ issueId: ISSUE, runId: RUN, origin, basePath: '' }),
      /origin/,
      JSON.stringify(origin),
    )
  }
})
