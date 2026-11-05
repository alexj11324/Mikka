import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { jsonbText } from './context'
import { isIdKey, previewFields, toolDetail, withoutIds } from './tool-detail'

const RUN = '2b2ff606-ecb7-4b11-a211-0000000000c3'
const TASK = '0a5c49d1-0d4d-489c-8f9e-0000000000a1'
const BOT = '3c3aa707-0000-4c22-b322-0000000000d4'
/** A preview as the chat gets it: jsonb's key order (shorter keys first), cut at 200 characters. */
const cut = (value: unknown) => jsonbText(value).slice(0, 200)
const NOTE = 'Upgrade axios in ledger-web to 1.7.4 to fix CVE-2024-39338, then run pnpm test and pnpm build and check that the request interceptors still work. If follow-redirects needs a bump too, stop and ask first.'

test('tool details bundle for the browser without importing server message signing', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: [fileURLToPath(new URL('./tool-detail.ts', import.meta.url))],
    bundle: true, platform: 'browser', format: 'esm', treeShaking: false,
    write: false, metafile: true, logLevel: 'silent',
  })
  assert.ok(result.outputFiles[0].text.length > 0)
  assert.doesNotMatch(Object.keys(result.metafile.inputs).join('\n'), /coordinator\/(?:context|message-safety)\.ts/)
})

test('a dispatch is who it went to and its thread, then its note as a quote; it never draws the task (R-15)', () => {
  const lines = toolDetail({ name: 'dispatch_run', input: cut({ issueId: TASK, botId: BOT, note: 'Fix the redirect' }), output: cut({ runId: RUN, status: 'queued', harness: 'codex' }) })
  assert.deepEqual(lines, [{ kind: 'handoff', runId: RUN, harness: 'codex', status: 'queued' }, { kind: 'quote', text: 'Fix the redirect' }])
})

test('a long note in a cut jsonb preview still shows: from the call\'s own quote, or from what arrived of it', () => {
  assert.ok(NOTE.length > 190)
  const input = cut({ issueId: TASK, botId: BOT, note: NOTE })
  assert.ok(input.startsWith('{"note": '), 'jsonb puts the note first, and the cut falls inside it')
  const whole = toolDetail({ name: 'dispatch_run', input, quote: NOTE, output: cut({ runId: RUN }) })
  assert.deepEqual(whole.find(line => line.kind === 'quote'), { kind: 'quote', text: NOTE }, 'the server\'s quote, whole')
  const partial = toolDetail({ name: 'dispatch_run', input, output: cut({ runId: RUN }) }).find(line => line.kind === 'quote')
  assert.ok(partial?.kind === 'quote' && partial.text.endsWith('…') && NOTE.startsWith(partial.text.slice(0, -1)), 'without it, what arrived and an ellipsis')
})

test('a failed call says nothing in words: its row names the reason, and what it asked never happened', () => {
  assert.deepEqual(toolDetail({ name: 'send_email', input: cut({ to: 'a@example.com', subject: 'Hi', body: 'Hello' }), output: '{"error": "forbidden"}' }, true), [])
  assert.deepEqual(toolDetail({ name: 'dispatch_run', input: cut({ note: 'Go' }), output: '{"error": "noDevice"}' }, true), [])
})

test('no id shows: id keys in any casing, ids inside values, opaque ids, and ids in a quote', () => {
  const lines = toolDetail({ name: 'mystery_tool', input: cut({ ID: 'x1', runID: 'x2', run_id: 'x3', path: `/runs/${RUN}`, ref: `run:${RUN}`, bot: 'b_9f8e7d', key: 'dispatch:toolu_01AbCdEf', name: 'Weekly sync' }) })
  assert.deepEqual(lines, [{ kind: 'pair', key: 'name', value: 'Weekly sync' }])
  assert.equal(withoutIds(`Continue in run ${RUN} with toolu_01AbCdEf`), 'Continue in run … with …')
  const [, quote] = toolDetail({ name: 'dispatch_run', input: cut({ note: `Pick up where ${RUN} stopped` }) })
  assert.deepEqual(quote, { kind: 'quote', text: 'Pick up where … stopped' })
})

test('an unregistered tool lists six fields in all, input and output together, values cut short', () => {
  const lines = toolDetail({ name: 'mystery_tool', input: JSON.stringify({ a: 1, b: true, c: 'c', d: 'd' }), output: JSON.stringify({ e: 'e', f: 'f', g: 'g', long: 'x'.repeat(200) }) })
  assert.deepEqual(lines.map(line => line.kind === 'pair' && line.key), ['a', 'b', 'c', 'd', 'e', 'f'])
  const long = toolDetail({ name: 'mystery_tool', input: JSON.stringify({ long: 'x'.repeat(200) }) })[0]
  assert.equal(long.kind === 'pair' && long.value.length, 80)
})

test('registered tools say their object, query, count and words', () => {
  assert.deepEqual(toolDetail({ name: 'list_issues', input: cut({ query: 'login' }), output: '{"issues": [{}, {}, {}]}' }),
    [{ kind: 'field', label: 'query', value: 'login' }, { kind: 'field', label: 'count', value: 3 }])
  assert.deepEqual(toolDetail({ name: 'create_issue', input: cut({ title: 'Fix login', status: 'todo' }), output: cut({ id: TASK }) }),
    [{ kind: 'object', id: TASK }, { kind: 'field', label: 'title', value: 'Fix login' }, { kind: 'field', label: 'status', value: 'todo' }])
  assert.deepEqual(toolDetail({ name: 'send_to_run', input: cut({ runId: RUN, message: 'Also update the lockfile' }) }),
    [{ kind: 'object', id: RUN }, { kind: 'quote', text: 'Also update the lockfile' }])
})

test('a preview cut at 200 characters still gives its whole leading fields', () => {
  assert.deepEqual(previewFields(`{"limit": 5, "query": "login", "note": "${'x'.repeat(300)}`), { limit: 5, query: 'login', note: `${'x'.repeat(300)}…` })
  assert.deepEqual(previewFields('not json'), {})
  assert.deepEqual(previewFields('[1, 2]'), { items: [1, 2] })
})

test('id keys in every casing and joining are ids; words that only end in "id" are not', () => {
  for (const key of ['id', 'ID', 'Id', 'ids', 'uuid', 'runId', 'runID', 'run_id', 'run-id', 'runid', 'threadid', 'threadIds', 'issue_uuid', 'parent id'])
    assert.ok(isIdKey(key), key)
  for (const key of ['valid', 'paid', 'android', 'fluid', 'Valid', 'avoid', 'name', 'identity', 'idle'])
    assert.ok(!isIdKey(key), key)
})

test('values holding an id are left out, and a quote shows none: hex, ULID, prefixed and Slack ids', () => {
  const probes = { a: '507f1f77bcf86cd799439011', b: 'd41d8cd98f00b204e9800998ecf8427e', c: '01ARZ3NDEKTSV4RRFFQ69G5FAV', d: 'run-2b2ff606', e: 'b_9f8e7', f: 'C01234ABCDE', g: 'see U024BE7LH please', h: `/runs/${RUN.toUpperCase()}` }
  assert.deepEqual(toolDetail({ name: 'mystery_tool', input: JSON.stringify({ ...probes, name: 'Weekly sync', words: 'CHANGELOG entry for CVE-2024-39338 in follow-redirects' }) }),
    [{ kind: 'pair', key: 'name', value: 'Weekly sync' }, { kind: 'pair', key: 'words', value: 'CHANGELOG entry for CVE-2024-39338 in follow-redirects' }], 'ids go; plain words with numbers stay')
  for (const value of Object.values(probes)) assert.doesNotMatch(withoutIds(`x ${value} y`), /[0-9]{3}|_9f|2b2f|ABCDE|U024/, value)
  assert.deepEqual(toolDetail({ name: 'send_slack_message', input: cut({ channel: 'C01234ABCDE', text: 'Deploy done' }) }), [{ kind: 'quote', text: 'Deploy done' }], 'a Slack channel id is not a recipient to show')
})

test('a dispatch names the coding agent from its model when the answer does not', () => {
  const [handoff] = toolDetail({ name: 'dispatch_run', input: JSON.stringify({ issueId: TASK, model: { harness: 'codex' }, note: 'Go' }), output: cut({ runId: RUN, status: 'queued' }) })
  assert.deepEqual(handoff, { kind: 'handoff', runId: RUN, harness: 'codex', status: 'queued' })
})
