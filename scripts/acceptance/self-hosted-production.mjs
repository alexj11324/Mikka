#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { attestCoreProduction, assertCoreProductionTarget, coreBusinessSelected, coreTargetFailure } from './self-hosted-production-target.mjs'
import { runMobileDaemonProof } from '../ops/production-mobile-daemon.mjs'

export async function runCoreProduction({ env = process.env, event, attestation, ...options } = {}) {
  const fresh = await assertCoreProductionTarget({ env, event, attestation, fetchImpl: options.fetchImpl, now: options.now })
  if (!coreBusinessSelected(fresh)) return { status: 'skipped', code: 'core_business_issues_closed',
    applicationSha: fresh.applicationSha, driverRunId: fresh.driverRunId }
  return runMobileDaemonProof({ env, event, attestation: fresh, ...options })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attesting = process.argv.includes('--attest')
  let report
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report = attesting ? await attestCoreProduction({ event }) : await runCoreProduction({ event,
      attestation: JSON.parse(await readFile('self-hosted-production-report/attestation.json', 'utf8')) })
  } catch (error) { report = { status: 'blocked', ...coreTargetFailure(error) } }
  await mkdir('self-hosted-production-report', { recursive: true, mode: 0o700 })
  const json = JSON.stringify(report, null, 2) + '\n'
  await writeFile('self-hosted-production-report/' + (attesting ? 'attestation' : 'report') + '.json', json, { mode: 0o600 })
  // Closed aggregates remain in the job log/summary even when artifact storage
  // is at quota. No identities, tickets, cookies or provider responses are kept.
  console.log(json)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '## Mikka cloud core compatibility ' + (attesting ? 'target' : 'API acceptance') + '\n\n'
    + 'Result: ' + report.status + '. No model calls, cloud computers, browser, OAuth or billing settlement are exercised.\n\n'
    + '```json\n' + json + '```\n')
  if (attesting && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    'readable=' + (report.readable === true) + '\ncore_selected=' + coreBusinessSelected(report) + '\n')
  process.exitCode = attesting
    ? (report.status === 'ready' || report.status === 'skipped' && report.code === 'core_issues_closed' ? 0 : 1)
    : report.status === 'pass' || report.status === 'skipped' && report.code === 'core_business_issues_closed' ? 0 : 1
}
