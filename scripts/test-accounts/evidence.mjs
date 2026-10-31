#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { auditEvidence } from './session.mjs'

const failureCodes = new Set([
  'EVIDENCE_MISSING', 'EVIDENCE_SECRET_DETECTED', 'EVIDENCE_SYMLINK_FORBIDDEN', 'EVIDENCE_FILE_UNSAFE',
  'EVIDENCE_ARCHIVE_MALFORMED', 'EVIDENCE_ARCHIVE_LIMIT', 'EVIDENCE_ARCHIVE_UNSUPPORTED', 'EVIDENCE_ARCHIVE_PATH_INVALID',
  'UNREVIEWED_SECRET_BEARING_EVIDENCE', 'PRIVATE_DIRECTORY_UNSAFE', 'PRIVATE_FILE_UNSAFE',
  'SECRET_AUDIT_UNREADABLE', 'SECRET_AUDIT_INVALID', 'SECRET_AUDIT_MISSING',
])

export function formatEvidenceFailure(error) {
  let safeCode = 'EVIDENCE_AUDIT_FAILED'
  try {
    // Only an exact, own string code is eligible. Never read messages, stacks,
    // accessors or string coercions that could reveal paths or credentials.
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof code === 'string' && failureCodes.has(code)) safeCode = code
  } catch { /* Unknown error shapes receive the same fixed fallback. */ }
  return JSON.stringify({ status: 'blocked', safeCode })
}

async function main() {
  // An archive/HAR/recording from any failed auth test blocks the upload. Raw
  // Playwright traces contain cookies even when the screenshots look harmless.
  try {
    const paths = []
    for (const path of [
      'playwright-report', 'test-results', 'playwright-performance-report', 'performance-results',
      'playwright-mvp-report', 'mvp-test-results',
      '.cache/e2e/http-acceptance-summary.json', '.cache/e2e/account-http-evidence.json',
      '.cache/e2e/playwright-performance.log', '.cache/e2e/playwright-browser.log', '.cache/e2e/playwright-mvp.log',
      'playwright-selection-smoke-report', 'selection-smoke-results',
      'playwright-selection-targeted-report', 'selection-targeted-results',
      '.cache/e2e/playwright-selection.log',
      'playwright-turnstile-report', 'turnstile-results', '.cache/e2e/playwright-turnstile.log',
    ]) {
      try { await stat(path); paths.push(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!paths.length) throw Object.assign(new Error('EVIDENCE_MISSING'), { code: 'EVIDENCE_MISSING' })
    console.log(JSON.stringify(await auditEvidence(paths)))
  } catch (error) {
    console.error(formatEvidenceFailure(error))
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
