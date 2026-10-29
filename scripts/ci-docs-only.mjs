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
// Also selects the browser layer. Unknown/shared paths run full functionality;
// main, nightly and manual integration runs include performance. All outputs
// are computed by the trusted main copy, never by PR-supplied path patterns.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Paths whose changes cannot require a build or a browser test. */
const DOCS_ONLY = [
  /^docs\/.*\.md$/,
  /^tasks\/.*\.md$/,
  /^README(?:\.[^/]+)?\.md$/,
  /^LICENSE$/,
  /^AGENTS\.md$/,
  /^\.github\/pull_request_template\.md$/,
]

export function isDocsOnly(files, unsafeModes = false) {
  return !unsafeModes && files.length > 0 && files.every(file => (file === 'AGENTS.md' || !/(?:^|\/)AGENTS\.md$/.test(file)) && DOCS_ONLY.some(pattern => pattern.test(file)))
}

// Whole existing specs, rather than title grep filters: assertions stay intact.
export const BROWSER_SMOKE = Object.freeze([
  'routes.spec.ts', 'workspace.spec.ts', 'test-account-pool.spec.ts', 'sign-out.spec.ts',
])
export const BROWSER_INFRA_FILES = Object.freeze([".github/workflows/browser-tests.yml", ".github/workflows/ui-policy.yml", "scripts/ci-docs-only.mjs", "scripts/ci-docs-only.test.mjs", "scripts/ci-browser-tests.mjs", "scripts/ci-browser-tests.test.mjs", "scripts/run-db-tests.mjs", "scripts/run-db-tests.test.mjs", "scripts/test-accounts/evidence.mjs", "CONTRIBUTING.md"])
const SELECTION_POLICY_FILES = new Set([".github/workflows/browser-tests.yml", "scripts/ci-docs-only.mjs", "scripts/ci-docs-only.test.mjs", "scripts/ci-browser-tests.mjs", "scripts/ci-browser-tests.test.mjs", "scripts/test-accounts/evidence.mjs"])
export const needsSelectionValidation = files => files.some(file => SELECTION_POLICY_FILES.has(file))
const SCOPED_BROWSER = [
  { paths: [/^lib\/(?:search|federated-search)\//, /^lib\/issue-search(?:\.|-)/, /^app\/api\/(?:search|issues\/search)\//], specs: ['site-search.spec.ts'] },
  { paths: [/^components\/settings\//, /^app\/\[locale\]\/settings\//], specs: ['settings.spec.ts', 'settings-surface.spec.ts', 'members.spec.ts', 'teams.spec.ts', 'workspace-menu.spec.ts'] },
  { paths: [/^lib\/slack\//, /^app\/api\/webhooks\/slack\//], specs: ['slack-webhook.spec.ts'] },
]
export const BROWSER_SCOPED_SPECS = Object.freeze([...new Set(SCOPED_BROWSER.flatMap(rule => rule.specs))])
const PERFORMANCE_SPECS = ['tests/e2e/navigation-performance.spec.ts', 'tests/e2e/agent-performance.spec.ts']

/** No dependency graph guess: only explicitly mapped production paths reduce coverage. */
export function browserPlan(files, { unsafeModes = false, integration = false } = {}) {
  const full = performance => ({ tier: 'full', specs: [], performance })
  if (integration) return full(true)
  if (unsafeModes || !files.length) return full(files.some(path => PERFORMANCE_SPECS.includes(path)))
  if (isDocsOnly(files)) return { tier: 'docs', specs: [], performance: false }
  const specs = new Set(BROWSER_SMOKE)
  let targeted = false
  for (const file of files) {
    if (isDocsOnly([file]) || BROWSER_INFRA_FILES.includes(file)) continue
    // Shared fixtures and unknown browser specs still require full functionality.
    // Pure CI changes use critical flows; selection changes also verify subsets.
    if (file.startsWith('tests/e2e/')) {
      if (file.startsWith('tests/e2e/') && [...BROWSER_SMOKE, ...BROWSER_SCOPED_SPECS].some(spec => file === `tests/e2e/${spec}`)) {
        specs.add(file.slice('tests/e2e/'.length)); targeted = true; continue
      }
      return full(files.some(path => PERFORMANCE_SPECS.includes(path)))
    }
    const rule = SCOPED_BROWSER.find(rule => rule.paths.some(pattern => pattern.test(file)))
    if (rule) {
      for (const spec of rule.specs) specs.add(spec)
      targeted = true
      continue
    }
    // Source-only tests and unrelated workflows do not change application code.
    // Their own unit/build gates still run; browser smoke still exercises runtime.
    if (/\.test\.(?:ts|tsx|mjs|mts)$/.test(file) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) continue
    return full(files.some(path => PERFORMANCE_SPECS.includes(path)))
  }
  return { tier: targeted ? 'targeted' : 'smoke', specs: [...specs].sort(), performance: false }
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
    `Browser layer: **${plan.tier}**. Performance: **${plan.performance ? 'required' : 'deferred to integration'}**.\n\n${plan.specs.map(spec => `- ${spec}`).join('\n')}\n`)

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
  const plan = mainPush && !docsOnly
    ? browserPlan([], { integration: true })
    : browserPlan(result.files, { unsafeModes: result.unsafeModes })
  output(docsOnly, result.unsafeModes ? `${reason}; non-regular path or unmerged entry` : reason, plan, needsSelectionValidation(result.files))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
