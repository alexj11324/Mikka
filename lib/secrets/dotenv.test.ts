import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOTENV_MAX_BYTES, parseDotenv } from './dotenv'

test('one KEY=value per line, with an optional # note after the value', () => {
  const { entries, errors } = parseDotenv('VERCEL_TOKEN=abc123 # 部署预览\nSENTRY_DSN=https://x@y/1\n')
  assert.deepEqual(entries, [
    { line: 1, name: 'VERCEL_TOKEN', value: 'abc123', note: '部署预览' },
    { line: 2, name: 'SENTRY_DSN', value: 'https://x@y/1', note: '' },
  ])
  assert.deepEqual(errors, [])
})

test('quotes keep # and spaces in the value; export, blank and comment lines; CRLF', () => {
  const text = '# header\r\n\r\nexport A="x # not a note"\r\nB=\'single quoted\' # note b\r\nC=a#b\r\n'
  assert.deepEqual(parseDotenv(text).entries, [
    { line: 3, name: 'A', value: 'x # not a note', note: '' },
    { line: 4, name: 'B', value: 'single quoted', note: 'note b' },
    { line: 5, name: 'C', value: 'a#b', note: '' },
  ])
})

test('each bad line is reported by number; good lines still parse', () => {
  const { entries, errors } = parseDotenv('GOOD=1\nno equals sign\n1BAD=2\nEMPTY=\nGOOD=3\nQ="unterminated\n')
  assert.deepEqual(entries.map(entry => [entry.line, entry.name, entry.value]), [[1, 'GOOD', '1']])
  assert.deepEqual(errors, [
    { line: 2, reason: 'invalidLine' },
    { line: 3, name: '1BAD', reason: 'invalidName' },
    { line: 4, name: 'EMPTY', reason: 'emptyValue' },
    { line: 5, name: 'GOOD', reason: 'duplicate' },
    { line: 6, name: 'Q', reason: 'invalidLine' },
  ])
})

test('a file over 2 MB is refused whole', () => {
  assert.equal(DOTENV_MAX_BYTES, 2 * 1024 * 1024)
  assert.throws(() => parseDotenv('A=' + 'x'.repeat(DOTENV_MAX_BYTES)), /dotenvTooLarge/)
})
