// Execute a trusted classifier's browser plan as argv, never as shell code.
import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, lstatSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { browserPlan, BROWSER_MAIN_SPECS, BROWSER_SCOPED_SPECS, BROWSER_SMOKE_TAG, BROWSER_SPEC_NAME } from './ci-docs-only.mjs'

/** Cloudflare's documented always-pass test secret; public, never a credential. */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'
export const TURNSTILE_TAG = '@turnstile'

const SHARDED_TIERS = new Set(['main', 'full'])

/** Playwright matches --grep against "project file describe title tags"; a whole
 * file is selected by its name between spaces. Names are validated first. */
export function specGrep(specs) {
  return `${BROWSER_SMOKE_TAG}|(?:^| )(?:${specs.map(spec => spec.replace(/\./g, '\\.')).join('|')}) `
}

export function browserArguments(tier, encodedSpecs, shard, { specExists = spec => existsSync(`tests/e2e/${spec}`) } = {}) {
  const specs = JSON.parse(encodedSpecs)
  if (!Array.isArray(specs) || specs.some(spec => typeof spec !== 'string') || new Set(specs).size !== specs.length) throw new Error('Invalid browser spec list')
  if (specs.some(spec => !BROWSER_SPEC_NAME.test(spec) || !specExists(spec))) throw new Error('Unrecognized browser spec')
  const args = ['exec', 'playwright', 'test']
  if (tier === 'smoke') {
    if (specs.length) throw new Error('Invalid smoke plan')
    args.push('--grep', BROWSER_SMOKE_TAG)
  } else if (tier === 'targeted') {
    if (!specs.length) throw new Error('Targeted plan needs specs')
    args.push('--grep', specGrep(specs))
  } else if (tier === 'main') {
    if (specs.length) throw new Error('The main tier cannot be narrowed')
    args.push(...BROWSER_MAIN_SPECS.map(spec => `tests/e2e/${spec}`))
  } else if (tier === 'full') {
    if (specs.length) throw new Error('Full regression cannot be narrowed')
  } else throw new Error('Missing or invalid browser tier')
  args.push('--grep-invert', '@performance')
  if (shard !== undefined) {
    if (!SHARDED_TIERS.has(tier)) throw new Error('Only the main and full tiers are sharded')
    if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error('Invalid browser shard')
    const [index, total] = shard.split('/').map(Number)
    if (index > total) throw new Error('Invalid browser shard')
    args.push(`--shard=${shard}`)
  }
  return args
}

/** The keyed sign-up run: only tests tagged @turnstile, against a server that
 * holds Cloudflare's test secret, so the token path is verified end to end. */
export function turnstileArguments() {
  return ['exec', 'playwright', 'test', '--grep', TURNSTILE_TAG, '--grep-invert', '@performance', '--output=turnstile-results']
}

// Policy changes must exercise actual subset execution. The smoke plan covers
// the tag filter; the targeted plan covers the tag filter plus every scoped spec.
export function selectionValidationPlans() {
  return [browserPlan(['lib/model.test.ts']), { tier: 'targeted', specs: [...BROWSER_SCOPED_SPECS], performance: false }]
}

/** One named subset, so each policy plan can run as its own job. */
export function selectionPlan(name) {
  const [critical, scoped] = selectionValidationPlans()
  if (name === 'smoke') return critical
  if (name === 'targeted') return scoped
  throw new Error('Invalid selection plan')
}

function run(args, env = process.env) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  return result
}

export function main() {
  const legacyValidation = process.argv.includes('--verify-selection')
  const planName = process.argv.find(argument => argument.startsWith('--verify-selection-plan='))?.slice('--verify-selection-plan='.length)
  const validating = legacyValidation || planName !== undefined
  const shard = process.argv.find(argument => argument.startsWith('--shard='))?.slice('--shard='.length)
  if (validating && shard) throw new Error('Selection validation must run unsharded')
  if (legacyValidation && planName !== undefined) throw new Error('Choose one selection validation mode')
  if (process.argv.includes('--turnstile')) {
    if (validating || shard) throw new Error('The Turnstile run is a single unsharded subset')
    const args = turnstileArguments()
    console.log(`Browser acceptance layer: turnstile; ${args.join(' ')}`)
    const result = run(args, { ...process.env, TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET, PLAYWRIGHT_HTML_OUTPUT_DIR: 'playwright-turnstile-report' })
    if (result.status !== 0) process.exitCode = result.status ?? 1
    return
  }
  const plans = planName !== undefined
    ? [selectionPlan(planName)]
    : validating
      ? selectionValidationPlans()
      : [{ tier: process.env.BROWSER_TIER, specs: JSON.parse(process.env.BROWSER_SPECS) }]
  for (const plan of plans) {
    const args = browserArguments(plan.tier, JSON.stringify(plan.specs), validating ? undefined : shard)
    console.log(`Browser acceptance layer: ${plan.tier}; ${args.join(' ')}`)
    // Keep each subset's reports separate from subsequent runs.
    if (validating) args.push(`--output=selection-${plan.tier}-results`)
    const env = validating ? { ...process.env, PLAYWRIGHT_HTML_OUTPUT_DIR: `playwright-selection-${plan.tier}-report` } : process.env
    const result = run(args, env)
    if (validating && plan.tier === 'targeted') {
      // The existing search spec writes this extra fixture receipt outside its
      // Playwright outputDir. Preserve it before a later run initializes that
      // directory, including receipts generated by a failing child.
      const receipt = 'test-results/site-search-fixtures.json'
      if (existsSync(receipt)) {
        const info = lstatSync(receipt)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('UNSAFE_SELECTION_RECEIPT')
        copyFileSync(receipt, 'selection-targeted-results/site-search-fixtures.json', constants.COPYFILE_EXCL)
      } else if (result.status === 0) throw new Error('MISSING_SELECTION_RECEIPT')
    }
    if (result.status !== 0) { process.exitCode = result.status ?? 1; return }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
