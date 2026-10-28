#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { auditEvidence } from './session.mjs'

// An archive/HAR/recording from any failed auth test blocks the upload. Raw
// Playwright traces contain cookies even when the screenshots look harmless.
try {
  const paths = []
  for (const path of [
    'playwright-report', 'test-results', 'playwright-performance-report', 'performance-results',
    '.cache/e2e/http-acceptance-summary.json', '.cache/e2e/account-http-evidence.json',
    '.cache/e2e/playwright-performance.log', '.cache/e2e/playwright-browser.log',
  ]) {
    try { await stat(path); paths.push(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!paths.length) throw new Error('EVIDENCE_MISSING')
  console.log(JSON.stringify(await auditEvidence(paths)))
} catch {
  console.error('Account evidence upload blocked: secret scan failed or evidence contains an unreviewed archive/recording.')
  process.exitCode = 1
}
