// Tells CI whether a change only touches documentation.
//
// The branch protection on main requires four status checks. A workflow that
// is skipped by `paths-ignore` never reports them, so the pull request stays
// blocked forever. Instead the workflows always run and use this output to
// skip their heavy jobs; a small gate job keeps the required check names and
// reports success for a documentation-only change.
//
// The workflows must run this file from `origin/main`, never from the pull
// request's checkout: otherwise a pull request could rewrite the classifier
// and skip its own required checks.
//
//   node scripts/ci-docs-only.mjs            # reads the GitHub event payload
//   node scripts/ci-docs-only.mjs --base origin/main --head HEAD
//
// Also selects the browser layer: pull requests run the smoke set, code-bearing
// main pushes and nightly and manual runs run every spec plus performance. All outputs are computed by the trusted main
// copy, never by PR-supplied path patterns.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Paths whose changes cannot require a build or a browser test. */
const DOCS_ONLY = [
  /^docs\/.*\.md$/,
  /^tasks\/.*\.md$/,
  /^README(?:\.[^/]+)?\.md$/,
  /^LICENSE$/,
  /^AGENTS\.md$/,
  /^\.github\/pull_request_template\.md$/,
  // README diagrams and the scripts that draw them; nothing in the app imports either.
  /^docs\/assets\/[^/]+\.svg$/,
  /^scripts\/(?:generate-diagrams|diagram-svg)\.mjs$/,
]

function isDocumentationFile(file) {
  return (file === 'AGENTS.md' || !/(?:^|\/)AGENTS\.md$/.test(file)) && DOCS_ONLY.some(pattern => pattern.test(file))
}

export function isDocsOnly(files, unsafeModes = false) {
  return !unsafeModes && files.length > 0 && files.every(isDocumentationFile)
}

/** Schema-only changes add migrations and documentation, never application code.
 * Their migration/bootstrap tests still run; browser coverage drops to critical flows. */
const SCHEMA_ONLY = /^drizzle\/[^/]+\.sql$/
export function isSchemaOnly(files) {
  return files.some(file => SCHEMA_ONLY.test(file)) && files.every(file => SCHEMA_ONLY.test(file) || isDocumentationFile(file))
}

// Browser tiers (CONTRIBUTING.md, "How changes are tested"):
// - smoke: every non-docs pull request runs the tests tagged @smoke (about ten
//   critical flows across the files below, plus the first MVP real-daemon test);
//   this is the only browser layer that blocks a merge;
// - full: every code-bearing push to main, nightly and manual runs, and
//   integrate/* pull requests run every spec plus performance on four shards.
//   A red main run opens or updates a browser-regression issue. Unsafe modes
//   and unknown ranges also take full.
// - targeted: the area specs below, run only by the selection validation of a
//   pull request that changes this policy.
// Every spec file belongs to main or to the nightly-only list (the order the
// full tier's shards reach them); a test is never dropped, only scheduled later.
export const BROWSER_SMOKE_TAG = '@smoke'
export const BROWSER_SPEC_NAME = /^[a-z0-9][a-z0-9-]*\.spec\.ts$/

function mapFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('Invalid browser map ' + label)
}

function mapStrings(values, label, pattern) {
  if (!Array.isArray(values) || new Set(values).size !== values.length || values.some(value => typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value)))) throw new Error('Invalid browser map ' + label)
}

function readBrowserMap(file) {
  if (!lstatSync(file).isFile()) throw new Error('Browser map must be a regular file')
  const map = JSON.parse(readFileSync(file, 'utf8'))
  mapFields(map, ['smoke', 'main', 'nightly', 'areas'], 'fields')
  for (const tier of ['smoke', 'main', 'nightly']) mapStrings(map[tier], tier, BROWSER_SPEC_NAME)
  if (map.smoke.some(spec => !map.main.includes(spec)) || map.main.some(spec => map.nightly.includes(spec))) throw new Error('Invalid browser map tier membership')
  if (!Array.isArray(map.areas)) throw new Error('Invalid browser map areas')
  const names = new Set()
  for (const area of map.areas) {
    mapFields(area, ['area', 'paths', 'specs'], 'area fields')
    if (typeof area.area !== 'string' || !area.area.trim() || names.has(area.area)) throw new Error('Invalid browser map area name')
    names.add(area.area)
    mapStrings(area.paths, 'paths')
    mapStrings(area.specs, 'area specs', BROWSER_SPEC_NAME)
    if (!area.paths.length || !area.specs.length) throw new Error('Empty browser map area')
  }
  return map
}

const BROWSER_MAP = readBrowserMap(new URL('./ci-browser-map.json', import.meta.url))
export const BROWSER_SMOKE_FILES = Object.freeze(BROWSER_MAP.smoke)
export const BROWSER_MAIN_SPECS = Object.freeze(BROWSER_MAP.main)
export const BROWSER_NIGHTLY_SPECS = Object.freeze(BROWSER_MAP.nightly)
// Only the paired trusted map's expressions are compiled; PR paths remain data.
const SCOPED_BROWSER = BROWSER_MAP.areas.map(area => ({ ...area, paths: area.paths.map(path => new RegExp(path)) }))
export const BROWSER_INFRA_FILES = Object.freeze([".github/workflows/browser-tests.yml", ".github/workflows/ui-policy.yml", ".github/workflows/analytics-ssr.yml", ".github/actions/pnpm-install/action.yml", ".github/actions/playwright-chromium/action.yml", "scripts/ci-docs-only.mjs", "scripts/ci-browser-map.json", "scripts/ci-docs-only.test.mjs", "scripts/ci-browser-tests.mjs", "scripts/ci-browser-tests.test.mjs", "scripts/run-db-tests.mjs", "scripts/run-db-tests.test.mjs", "scripts/test-accounts/evidence.mjs", "CONTRIBUTING.md"])
const SELECTION_POLICY_FILES = new Set([".github/workflows/browser-tests.yml", "scripts/ci-docs-only.mjs", "scripts/ci-docs-only.test.mjs", "scripts/ci-browser-tests.mjs", "scripts/ci-browser-tests.test.mjs", "scripts/test-accounts/evidence.mjs"])
export const needsSelectionValidation = files => files.some(file => SELECTION_POLICY_FILES.has(file))
export const BROWSER_SCOPED_SPECS = Object.freeze([...new Set(SCOPED_BROWSER.flatMap(rule => rule.specs))].sort())
const PERFORMANCE_SPECS = ['tests/e2e/navigation-performance.spec.ts', 'tests/e2e/agent-performance.spec.ts']
/** Paths the performance budgets measure: navigation shell, settings and saved history. */
const PERFORMANCE_PATHS = [
  /^components\/(?:app-shell|app-sidebar|nav-main|nav-secondary|nav-user)\.tsx$/, /^components\/ui\/sidebar\.tsx$/,
  /^components\/settings\//, /^app\/\[locale\]\/settings\//, /^lib\/settings-(?:navigation|sections)\.ts$/,
  /^components\/workspace\/agent-conversation\.tsx$/, /^lib\/agent-history\.ts$/, /^next\.config\./,
]
const touchesPerformance = files => files.some(file => PERFORMANCE_SPECS.includes(file) || PERFORMANCE_PATHS.some(pattern => pattern.test(file)))

/** Pull requests run the smoke set; everything else waits for the full run on main. */
export function browserPlan(files, { unsafeModes = false, integration = false, mainPush = false } = {}) {
  const full = performance => ({ tier: 'full', specs: [], performance })
  if (integration) return full(true)
  if (unsafeModes || !files.length) return full(mainPush || touchesPerformance(files))
  if (isDocsOnly(files)) return { tier: 'docs', specs: [], performance: false }
  if (mainPush) return full(true)
  return { tier: 'smoke', specs: [], performance: false }
}

/** Only non-executable regular files are eligible. */
function isRegularMode(mode) {
  return mode === '100644'
}

/**
 * True when a raw diff contains a path whose type is not a regular file, or
 * an unmerged entry. A docs path that turns into a symlink or a submodule must
 * not count as documentation.
 */
export function hasUnsafeModes(rawDiff) {
  return rawDiff.split('\0').filter((_, index) => index % 2 === 0).filter(Boolean).some(line => {
    // With --no-renames -z, each header is followed by one NUL-delimited path.
    const header = line.startsWith(':') ? line.slice(1) : ''
    const [oldMode, newMode, , , status] = header.split(' ')
    if (!status) return true
    if (status.startsWith('U')) return true
    const added = status.startsWith('A')
    const deleted = status.startsWith('D')
    if (!added && !isRegularMode(oldMode)) return true
    if (!deleted && !isRegularMode(newMode)) return true
    return false
  })
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function output(docsOnly, reason, plan = browserPlan([]), verifySelection = false) {
  const value = docsOnly ? 'true' : 'false'
  console.log(`docs_only=${value} (${reason})`)
  const outputs = `docs_only=${value}\nbrowser_tier=${plan.tier}\nbrowser_specs=${JSON.stringify(plan.specs)}\nbrowser_performance=${plan.performance}\nverify_selection=${verifySelection}\n`
  console.log(`browser_tier=${plan.tier}; performance=${plan.performance}; specs=${JSON.stringify(plan.specs)}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Browser layer: **${plan.tier}**. Performance: **${plan.performance ? 'required' : 'deferred to nightly'}**.\n\n${plan.specs.map(spec => `- ${spec}`).join('\n')}\n`)

}

function eventPayload() {
  if (!process.env.GITHUB_EVENT_PATH) return {}
  return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
}

function changedFiles(base, head) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  const files = execFileSync('git', ['diff', '--no-renames', '-z', '--name-only', `${base}...${head}`], options)
    .split('\0').filter(Boolean)
  const raw = execFileSync('git', ['diff', '--no-renames', '-z', '--raw', '--no-abbrev', `${base}...${head}`], options)
  return { files, unsafeModes: hasUnsafeModes(raw) }
}

export function main() {
  let base = arg('--base')
  let head = arg('--head')
  let mainPush = false

  if (!base || !head) {
    const eventName = process.env.GITHUB_EVENT_NAME
    const payload = eventPayload()
    if (eventName === 'pull_request') {
      base = payload.pull_request?.base?.sha
      head = payload.pull_request?.head?.sha
    } else if (eventName === 'merge_group') {
      base = payload.merge_group?.base_sha
      head = payload.merge_group?.head_sha
    } else if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
      return output(false, 'integration run', browserPlan([], { integration: true }))
    } else if (eventName === 'push') {
      // A regular docs-only main push may skip heavy postsubmit checks;
      // nightly and manual integration still run full functionality.
      if (process.env.GITHUB_REF === 'refs/heads/main') {
        mainPush = true
        base = payload.before
        head = payload.after || process.env.GITHUB_SHA
      } else {
        // Classify the whole branch against main, not just the pushed commits:
        // a docs-only last push must not hide earlier code changes.
        base = 'origin/main'
        head = process.env.GITHUB_SHA
      }
    }
  }

  const emptySha = /^0+$/
  if (!base || !head || emptySha.test(base) || emptySha.test(head)) return output(false, 'no comparable range', browserPlan([], { integration: mainPush }))

  let result
  try {
    // Do not trust a force-pushed or unrelated main history for postsubmit skips.
    if (mainPush) execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' })
    result = changedFiles(base, head)
  } catch (error) {
    // Unknown histories and failed comparisons must run the full suites.
    return output(false, `git diff failed: ${error instanceof Error ? error.message : String(error)}`, browserPlan([], { integration: mainPush }))
  }

  const reason = result.files.length
    ? `${result.files.length} changed file(s)`
    : 'no changed files'
  const docsOnly = isDocsOnly(result.files, result.unsafeModes)
  const plan = browserPlan(result.files, { unsafeModes: result.unsafeModes, mainPush })
  output(docsOnly, result.unsafeModes ? `${reason}; non-regular path or unmerged entry` : reason, plan, !mainPush && needsSelectionValidation(result.files))
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
