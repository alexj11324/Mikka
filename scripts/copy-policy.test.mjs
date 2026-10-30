import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { bannedHits, allowedPaths } from './copy-policy.mjs'

test('no old cloud machine name anywhere in the repo', () => {
  let files = ''
  try {
    files = execFileSync('git', ['grep', '-l', '-i', '-P', 'mikka[\\s_-]*(cloud|云)|切换到云端', '--', '.', ...allowedPaths.map(path => `:!${path}`)], { encoding: 'utf8' })
  } catch (error) { if (error.status !== 1) throw error }
  const hits = files.split('\n').filter(Boolean).flatMap(file => bannedHits(readFileSync(file, 'utf8')).map(hit => `${file}:${hit.line}: ${hit.text}`))
  assert.deepEqual(hits, [], 'use 「E2B」 (through i18n) instead')
})

test('zh and en messages name the cloud machine 「E2B」', () => {
  for (const locale of ['zh-CN', 'en']) {
    const text = readFileSync(`messages/${locale}.json`, 'utf8')
    assert.deepEqual(bannedHits(text), [], locale)
    assert.match(text, /"cloud": "E2B"/, locale)
  }
})

test('negative examples are caught', () => {
  for (const sample of ['Mikka Cloud', 'Mikka cloud', 'mikka CLOUD', 'Mikka  Cloud', 'Mikka\tCloud', 'Mikka云', 'Mikka 云端', 'MikkaCloud', 'mikka-cloud', 'mikka_cloud', '"cloud": "Mikka Cloud"', '用 Mikka 云运行', 'Mikka 云', '「Mikka 云」', '切换到云端', '无法派发，切换到云端？'])
    assert.equal(bannedHits(sample).length, 1, sample)
  // A root README hit is caught by the same scan (README.md is not on the path allowlist).
  assert.ok(!allowedPaths.some(path => path.toLowerCase().includes('readme')))
  assert.equal(bannedHits('# Mikka\n\nRuns on Mikka Cloud.').length, 1)
})

test('identifiers, env vars and the decision log stay allowed', () => {
  for (const sample of ['MIKKA_CLOUD_COMPUTER_TASKS=1', 'process.env.MIKKA_CLOUD_WORKER_SHA', "cloudComputer: 'mikka-cloud-computer',", '--name mikka-cloud-desktop-NEW_VERSION'])
    assert.deepEqual(bannedHits(sample), [], sample)
  assert.ok(allowedPaths.includes('docs/design/decisions.md'))
})
