import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, timingSummary } from './summary.mjs'
test('timings separate queue-inclusive wall time from completed runner consumption', () => {
  const summary=timingSummary({id:7,run_attempt:1,html_url:'https://example.invalid/7',created_at:'2026-11-08T00:00:00Z'},[
    {name:'unit',status:'completed',conclusion:'success',started_at:'2026-11-08T00:01:00Z',completed_at:'2026-11-08T00:03:00Z'},
    {name:'DB',status:'completed',conclusion:'failure',started_at:'2026-11-08T00:01:00Z',completed_at:'2026-11-08T00:02:00Z'},
    {name:'unselected',status:'completed',conclusion:'skipped',started_at:'2026-11-08T00:00:00Z',completed_at:'2026-11-08T00:04:00Z'},
    {name:'gate',status:'in_progress',conclusion:null,started_at:'2026-11-08T00:03:00Z'},
  ],Date.parse('2026-11-08T00:04:00Z'))
  assert(summary.includes('240 s elapsed including queue; 3.00 completed runner-minutes'))
  assert(summary.includes('| DB | failure | 60 |'))
  assert(!summary.includes('| unselected |'))
  assert(!summary.includes('| gate |'))
})

test('the running gate uses its own attempt even if another retry is now latest', async t => {
  const [, sample] = JSON.parse(readFileSync(new URL('./fixtures/actions-rerun-timings.json', import.meta.url), 'utf8'))
  const directory = mkdtempSync(join(tmpdir(), 'ci-timing-summary-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const summaryPath = join(directory, 'summary.md')
  const base = sample.source.run_url
  const replies = new Map([
    [base, { ...sample.run, run_attempt: 3 }],
    [base + '/attempts/2', sample.attempt],
    [base + '/attempts/2/jobs?per_page=100', { total_count: sample.jobs.length, jobs: sample.jobs }],
  ])
  t.mock.method(globalThis, 'fetch', async url => {
    if (!replies.has(url)) throw new Error('unrecordedActionsEndpoint')
    return { ok: true, json: async () => replies.get(url) }
  })
  t.mock.method(Date, 'now', () => Date.parse('2026-11-20T18:25:18Z'))
  await main({ GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_RUN_ID: '44791185503', GITHUB_RUN_ATTEMPT: '2', GITHUB_STEP_SUMMARY: summaryPath })
  const summary = readFileSync(summaryPath, 'utf8')
  assert(summary.includes('attempt 2'))
  assert(summary.includes('177 s elapsed including queue; 2.75 completed runner-minutes'))
  assert(summary.includes('539 s total run lifetime'))
  assert(summary.includes('1 completed job retained from an earlier attempt'))
  assert(!summary.includes('| source | success | 28 |'))
})
