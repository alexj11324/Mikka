import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkErrorCodes,
  compareMessages,
  extractActionErrorCodes,
  extractPlaceholders,
  findHardcodedText,
  findMissingTranslationKeys,
  flattenMessages,
} from './check-i18n.mjs'

const messages = {
  'zh-CN': {
    Common: { close: '关闭' },
    Auth: { title: '登录' },
    Issue: { status: { todo: '待办' } },
    Board: { moved: '已移至{status}', threads: '{count, plural, other {# 条讨论}}' },
    Errors: { generic: '出错了', authRequired: '请先登录。' },
  },
  en: {
    Common: { close: 'Close' },
    Auth: { title: 'Sign in' },
    Issue: { status: { todo: 'Todo' } },
    Board: { moved: 'Moved to {status}', threads: '{count, plural, other {# discussions}}' },
    Errors: { generic: 'Something went wrong', authRequired: 'Please sign in first.' },
  },
}

test('flattenMessages turns a nested catalog into dotted keys', () => {
  assert.deepEqual([...flattenMessages({ A: { b: 'x', C: { d: 'y' } } }).keys()], ['A.b', 'A.C.d'])
})

test('extractPlaceholders reads named and plural placeholders', () => {
  assert.deepEqual([...extractPlaceholders('{count, plural, other {# items}} for {name}')], ['count', 'name'])
})

test('compareMessages accepts aligned catalogs', () => {
  assert.deepEqual(compareMessages(messages), [])
})

test('compareMessages reports missing, extra and empty keys', () => {
  const broken = structuredClone(messages)
  delete broken.en.Common.close
  broken.en.Extra = { key: 'x' }
  broken['zh-CN'].Board.moved = ''
  const problems = compareMessages(broken)
  assert.ok(problems.some(problem => problem.includes('missing key "Common.close"')))
  assert.ok(problems.some(problem => problem.includes('extra key "Extra.key"')))
  assert.ok(problems.some(problem => problem.includes('"Board.moved" must be a non-empty string')))
})

test('compareMessages rejects corrupted translation text in either locale', () => {
  for (const locale of ['zh-CN', 'en']) {
    const broken = structuredClone(messages)
    broken[locale].Common.close = 'Broken\uFFFDtext'
    assert.ok(compareMessages(broken).includes(`${locale}: "Common.close" contains a Unicode replacement character`))
  }
})

test('compareMessages reports placeholder mismatches', () => {
  const broken = structuredClone(messages)
  broken.en.Board.moved = 'Moved'
  const problems = compareMessages(broken)
  assert.ok(problems.some(problem => problem.includes('en: "Board.moved" is missing placeholder {status}')))
})

test('extractActionErrorCodes reads quoted entries and fails loudly when absent', () => {
  const source = `const OTHER = ['nope']\nexport const ACTION_ERROR_CODES = [\n  'issueStale',\n  "authRequired",\n] as const\n`
  assert.deepEqual(extractActionErrorCodes(source), ['issueStale', 'authRequired'])
  assert.equal(extractActionErrorCodes('export const NOPE = []'), null)
})

test('checkErrorCodes requires every code in both locales', () => {
  assert.deepEqual(checkErrorCodes(['generic', 'authRequired'], messages), [])
  assert.ok(checkErrorCodes(['missingCode'], messages).some(problem => problem.includes('Errors.missingCode')))
})

test('findHardcodedText catches JSX text and attributes, ignoring comments and console', () => {
  const source = `
    // 这是注释，不应命中
    export function Demo() {
      console.error('服务端日志')
      return <div aria-label="任务">任务</div>
    }
  `
  const problems = findHardcodedText('/tmp/demo.tsx', source)
  assert.equal(problems.length, 2)
  assert.ok(problems.every(problem => problem.includes('hardcoded text "任务"')))
})

test('findHardcodedText honors line and file ignores', () => {
  const source = `/* i18n-ignore-file */\nexport const A = <p>任务</p>`
  assert.deepEqual(findHardcodedText('/tmp/ignored.tsx', source), [])

  const line = `export const A = <p>任务</p>{/* i18n-ignore */}`
  assert.deepEqual(findHardcodedText('/tmp/line.tsx', line), [])
})

test('findHardcodedText catches Chinese in template literals', () => {
  const source = 'export const label = `已移至${status}`'
  assert.equal(findHardcodedText('/tmp/template.ts', source).length, 1)
})

test('findMissingTranslationKeys resolves namespaced and object-form translators', () => {
  const source = `
    import { useTranslations, getTranslations } from 'next-intl'
    export async function Demo() {
      const t = useTranslations('Auth')
      const statusT = useTranslations('Issue.status')
      const deviceT = await getTranslations({ locale: 'en', namespace: 'Common' })
      return <p>{t('title')}{statusT('todo')}{deviceT('close')}{t('missing')}</p>
    }
  `
  const reference = flattenMessages(messages['zh-CN'])
  const problems = findMissingTranslationKeys('/tmp/demo.tsx', source, reference)
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('missing translation key "Auth.missing"'))
})

test('findMissingTranslationKeys skips dynamic and ambiguous keys', () => {
  const source = `
    import { useTranslations } from 'next-intl'
    export function Demo({ kind }: { kind: string }) {
      const t = useTranslations('Auth')
      return <p>{t(\`status.\${kind}\`)}{t('title')}</p>
    }
    export function Other() {
      const t = useTranslations('Common')
      return <p>{t('close')}</p>
    }
  `
  const reference = flattenMessages(messages['zh-CN'])
  assert.deepEqual(findMissingTranslationKeys('/tmp/demo.tsx', source, reference), [])
})
