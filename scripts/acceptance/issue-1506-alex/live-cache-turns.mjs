// Adds actual live core consumers to the already-authorized short cache turns.
// No additional model message: the existing two/three turns produce the pushes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runCacheTurns } from './coordinator-cache-turns.mjs'
import { loadFixtureReceipt, validateFixtureReceipt, OUTPUT_DIR } from './coordinator-fixtures.mjs'
import { prepareLiveSource } from './live-source.mjs'
import { openLiveConsumers } from './live-consumer.mjs'

export async function runLiveCacheTurns({ env = process.env, fixtureReceipt: supplied = null,
  checkpoint = true, cacheDriver = runCacheTurns, sourceFactory = prepareLiveSource, observer = openLiveConsumers } = {}) {
  const fixtures = supplied ? validateFixtureReceipt(supplied, { ready: true }) : loadFixtureReceipt(env.MIKKA_FIXTURE_RECEIPT, { ready: true })
  const row = fixtures.fixtures.find(value => value.key === env.MIKKA_FIXTURE_KIND)
  if (!row) throw new Error('fixture_key_invalid')
  const tabCount = env.MIKKA_LIVE_TABS === undefined ? 3 : Number(env.MIKKA_LIVE_TABS)
  if (![2, 3].includes(tabCount) || env.MIKKA_LIVE_DELAY_ONE_RESULT !== undefined && !['0', '1'].includes(env.MIKKA_LIVE_DELAY_ONE_RESULT)) throw new Error('live_options_invalid')
  const source = sourceFactory(env.MIKKA_LIVE_SOURCE_ROOT)
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-cache-and-live', status: 'failed',
    applicationSha: env.MIKKA_ACCEPTANCE_SHA, sourceCommit: source.sourceCommit, fixtureKey: row.key,
    fixtureRunKey: fixtures.runKey, modelMessagesAddedForLive: 0, observation: null, live: null }
  const save = () => {
    if (!checkpoint) return
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(`${OUTPUT_DIR}/coordinator-live-${row.key}.json`, JSON.stringify(report, null, 2) + '\n')
  }
  try {
    report.observation = await cacheDriver({ env, fixtureReceipt: fixtures, checkpoint,
      openLive: async (session, chat) => observer(session, chat, { source, expectedSha: env.MIKKA_ACCEPTANCE_SHA,
        fixture: { botId: row.botId, workspace: fixtures.workspace }, tabCount,
        delayOneReturnedResult: env.MIKKA_LIVE_DELAY_ONE_RESULT === '1',
        checkpoint(value) { report.live = value; save() },
      }) })
    if (report.observation.status === 'observed' && report.live?.status === 'live_evidence_captured') report.status = 'observed'
  } catch { report.error = 'live_cache_failed' }
  finally { source.close(); save() }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runLiveCacheTurns()
    console.log(JSON.stringify(report)); if (report.status !== 'observed') process.exitCode = 1
  } catch { console.log(JSON.stringify({ issue: 1506, phase: 'alex-cache-and-live', status: 'failed', error: 'live_input_invalid' })); process.exitCode = 1 }
}
