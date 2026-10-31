import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { bannedHits, allowedPaths, machineNameKeys, machineNameProblems } from './copy-policy.mjs'

const lookupIn = messages => key => key.split('.').reduce((node, part) => node?.[part], messages)

test('no translated cloud brand or old cloud action anywhere in the repo', () => {
  let files = ''
  try {
    files = execFileSync('git', ['grep', '-l', '-i', '-P', 'mikka[\\s_-]*云|切换到云端', '--', '.', ...allowedPaths.map(path => `:!${path}`)], { encoding: 'utf8' })
  } catch (error) { if (error.status !== 1) throw error }
  const hits = files.split('\n').filter(Boolean).flatMap(file => bannedHits(readFileSync(file, 'utf8')).map(hit => `${file}:${hit.line}: ${hit.text}`))
  assert.deepEqual(hits, [], 'the cloud machine is 「Mikka Cloud」, untranslated')
})

test('zh and en messages name the cloud machine 「Mikka Cloud」', () => {
  for (const locale of ['zh-CN', 'en']) {
    const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))
    assert.equal(messages.Computer.cloud, 'Mikka Cloud', locale)
    assert.equal(messages.Shell.newTaskDialog.cloud, 'Mikka Cloud', locale)
    assert.deepEqual(machineNameProblems(lookupIn(messages)), [], locale)
    assert.deepEqual(bannedHits(JSON.stringify(messages, null, 1)), [], locale)
  }
})

test('the E2B key and provider strings keep the E2B name', () => {
  for (const locale of ['zh-CN', 'en']) {
    const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))
    assert.match(messages.AgentCopy.cloudKeySetup, /E2B/, locale)
    assert.match(messages.Errors.e2bKeyRateLimited, /E2B/, locale)
  }
})

test('negative examples are caught', () => {
  for (const sample of ['Mikka云', 'Mikka 云端', 'mikka-云', '用 Mikka 云运行', 'Mikka 云', '「Mikka 云」', '切换到云端', '无法派发，切换到云端？'])
    assert.equal(bannedHits(sample).length, 1, sample)
  assert.ok(!allowedPaths.some(path => path.toLowerCase().includes('readme')))
  assert.equal(bannedHits('# Mikka\n\n运行在 Mikka 云端。').length, 1)
  const messages = { Computer: { cloud: 'E2B' }, Shell: { newTaskDialog: { cloud: 'Mikka Cloud' } }, AgentCopy: { dispatchCloud: '用你的 E2B 运行' } }
  assert.deepEqual(machineNameProblems(lookupIn(messages)).map(problem => problem.split(':')[0]), ['Computer.cloud', 'AgentCopy.dispatchCloud'])
  assert.deepEqual(machineNameProblems(() => undefined).length, machineNameKeys.length)
})

test('the brand, identifiers and the decision log stay allowed', () => {
  for (const sample of ['Mikka Cloud', 'Agents on Mikka Cloud', '在 Mikka Cloud 上运行', 'MIKKA_CLOUD_COMPUTER_TASKS=1', "cloudComputer: 'mikka-cloud-computer',", '--name mikka-cloud-desktop-NEW_VERSION'])
    assert.deepEqual(bannedHits(sample), [], sample)
  assert.ok(allowedPaths.includes('docs/design/decisions.md'))
})
