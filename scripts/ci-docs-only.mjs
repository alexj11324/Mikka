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
// Also selects the browser layer: pull requests run smoke plus targeted specs,
// code-bearing main pushes run the main tier, nightly and manual runs run full
// functionality plus performance. All outputs are computed by the trusted main
// copy, never by PR-supplied path patterns.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
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
// - targeted: smoke plus the complete specs of each area whose paths changed,
//   and any existing spec the pull request edits;
// - main: every code-bearing push to main runs the functional spec files below
//   (whole files, including the smoke files) on two shards;
// - full: nightly, manual runs and integrate/* pull requests run every spec plus
//   performance on four shards. Unsafe modes and unknown ranges also take full.
// Every spec file belongs to main or to the nightly-only list, so a new spec has
// to choose its tier; a test is never dropped, only scheduled later.
export const BROWSER_SMOKE_TAG = '@smoke'
/** Spec files that hold at least one @smoke test. */
export const BROWSER_SMOKE_FILES = Object.freeze([
  'artifact-share-lifecycle.spec.ts', 'device-authorization.spec.ts', 'factory-acceptance-a2.spec.ts',
  'factory-acceptance-ui.spec.ts', 'pending-actions.spec.ts', 'profile.spec.ts', 'routes.spec.ts',
  'test-account-pool.spec.ts', 'workspace.spec.ts',
])
/** Whole files run after every code-bearing merge to main (with the smoke files). */
export const BROWSER_MAIN_SPECS = Object.freeze([
  ...BROWSER_SMOKE_FILES,
  'agent.spec.ts', 'bot-image-read.spec.ts', 'bots.spec.ts', 'computer-policy-settings.spec.ts',
  'coordinator-choice-card.spec.ts', 'coordinator-scroll.spec.ts', 'global-search-scope.spec.ts', 'invalid-issue-content.spec.ts',
  'issue-threads.spec.ts', 'linear-sync-disabled.spec.ts', 'members.spec.ts', 'mobile-handoff.spec.ts',
  'plugins-page.spec.ts',
  'settings.spec.ts', 'sign-out.spec.ts', 'suggestion-entry-contract.spec.ts', 'suggestions-rail.spec.ts',
  'teams.spec.ts', 'thread-cards.spec.ts', 'thread-projection.spec.ts', 'thread-stop.spec.ts',
  'workspace-menu.spec.ts',
  'abuse-ui.spec.ts', 'settings-audit.spec.ts', 'settings-billing.spec.ts', 'settings-general.spec.ts',
  'settings-secrets.spec.ts', 'settings-team-permissions.spec.ts', 'settings-tokens.spec.ts',
  'settings-usage.spec.ts', 'signup-turnstile.spec.ts',
  // API-only specs; they stay here until they move into the HTTP gate.
  'active-agents.spec.ts', 'factory-api.spec.ts', 'factory-check-api.spec.ts',
  'factory-execution-claim.spec.ts', 'self-improvement-api.spec.ts', 'site-search.spec.ts',
  'slack-webhook.spec.ts',
])
/** Run nightly (and on demand) only: performance, visual/layout, the click crawler,
 * slower edge cases, mocked-UI and harness specs waiting to be converted. */
export const BROWSER_NIGHTLY_SPECS = Object.freeze([
  'agent-performance.spec.ts', 'navigation-performance.spec.ts',
  'board-layout.spec.ts', 'browser-pane.spec.ts', 'issue-header-breadcrumb.spec.ts',
  'issue-menu-collision.spec.ts', 'offline-layout.spec.ts', 'settings-surface.spec.ts',
  'workspace-shortcuts.spec.ts', 'controls.spec.ts',
  'artifact-share.spec.ts', 'avatar.spec.ts', 'detail-return.spec.ts', 'github-integration.spec.ts',
  'progressive-loading.spec.ts', 'relations.spec.ts', 'thread-question.spec.ts',
  'credential-login-card.spec.ts', 'subagent-login-needs.spec.ts', 'unread.spec.ts',
  'control-audit.spec.ts', 'history-request-observer.spec.ts', 'test-account-origin-fence.spec.ts',
  'e2b-machine-name.spec.ts', 'factory-acceptance-shots.spec.ts',
])
export const BROWSER_INFRA_FILES = Object.freeze([".github/workflows/browser-tests.yml", ".github/workflows/ui-policy.yml", ".github/actions/pnpm-install/action.yml", "scripts/ci-docs-only.mjs", "scripts/ci-docs-only.test.mjs", "scripts/ci-browser-tests.mjs", "scripts/ci-browser-tests.test.mjs", "scripts/run-db-tests.mjs", "scripts/run-db-tests.test.mjs", "scripts/test-accounts/evidence.mjs", "CONTRIBUTING.md"])
const SELECTION_POLICY_FILES = new Set([".github/workflows/browser-tests.yml", "scripts/ci-docs-only.mjs", "scripts/ci-docs-only.test.mjs", "scripts/ci-browser-tests.mjs", "scripts/ci-browser-tests.test.mjs", "scripts/test-accounts/evidence.mjs"])
export const needsSelectionValidation = files => files.some(file => SELECTION_POLICY_FILES.has(file))
const SCOPED_BROWSER = [
  { area: 'search', paths: [/^lib\/(?:search|federated-search)\//, /^lib\/(?:issue|site)-search(?:\.|-)/, /^app\/api\/(?:search|issues\/search)\//, /^components\/workspace\/issue-search\.tsx$/], specs: ['site-search.spec.ts', 'global-search-scope.spec.ts'] },
  { area: 'settings', paths: [/^components\/settings\//, /^app\/\[locale\]\/settings\//, /^lib\/settings[-/.]/, /^lib\/profile\//, /^lib\/workspace-admin\//, /^components\/teams\//, /^components\/workspace-menu\.tsx$/, /^components\/workspace\/members-settings\.tsx$/], specs: ['settings.spec.ts', 'settings-surface.spec.ts', 'members.spec.ts', 'teams.spec.ts', 'workspace-menu.spec.ts', 'profile.spec.ts', 'computer-policy-settings.spec.ts', 'linear-sync-disabled.spec.ts', 'bots.spec.ts', 'abuse-ui.spec.ts', 'settings-audit.spec.ts', 'settings-billing.spec.ts', 'settings-general.spec.ts', 'settings-secrets.spec.ts', 'settings-team-permissions.spec.ts', 'settings-tokens.spec.ts', 'settings-usage.spec.ts'] },
  { area: 'plugins', paths: [/^components\/plugins\//, /^app\/api\/integrations\//], specs: ['plugins-page.spec.ts', 'linear-sync-disabled.spec.ts', 'github-integration.spec.ts'] },
  { area: 'slack', paths: [/^lib\/slack\//, /^app\/api\/webhooks\/slack\//], specs: ['slack-webhook.spec.ts'] },
  { area: 'factory', paths: [/^lib\/factory\//, /^app\/api\/factory\//, /^components\/(?:factory|workspace\/factory-)/, /^lib\/self-improvement\//, /^app\/api\/self-improvement\//, /^components\/workspace\/self-improvement\.tsx$/], specs: ['factory-acceptance-ui.spec.ts', 'factory-acceptance-a2.spec.ts', 'thread-question.spec.ts', 'factory-api.spec.ts', 'factory-check-api.spec.ts', 'factory-execution-claim.spec.ts', 'self-improvement-api.spec.ts'] },
  { area: 'threads', paths: [/^components\/coordinator\//, /^lib\/coordinator[-/.]/, /^lib\/(?:issue-threads|thread-groups|issue-thread-questions|run-control)\./, /^components\/workspace\/issue-thread/, /^app\/api\/(?:threads|coordinator)\//], specs: ['thread-cards.spec.ts', 'thread-projection.spec.ts', 'thread-stop.spec.ts', 'issue-threads.spec.ts', 'thread-question.spec.ts', 'coordinator-choice-card.spec.ts', 'coordinator-scroll.spec.ts'] },
  { area: 'suggestions', paths: [/^lib\/suggestions\//, /^components\/suggestions\//, /^app\/api\/suggestions\//], specs: ['suggestions-rail.spec.ts', 'suggestion-entry-contract.spec.ts'] },
  { area: 'devices', paths: [/^lib\/(?:device|mobile)-/, /^components\/(?:device-authorization\.tsx|devices\/)/, /^app\/api\/(?:devices|mobile)\//, /^app\/\[locale\]\/device\//], specs: ['device-authorization.spec.ts', 'mobile-handoff.spec.ts'] },
  { area: 'auth', paths: [/^lib\/(?:auth|session|email-sign-in)[-.]/, /^lib\/abuse\//, /^app\/api\/auth\//, /^components\/auth(?:\/|-form\.tsx$)/, /^app\/\[locale\]\/(?:sign-in|sign-up|verify-email|forgot-password|reset-password)\//], specs: ['sign-out.spec.ts', 'workspace.spec.ts', 'signup-turnstile.spec.ts'] },
  { area: 'relations', paths: [/^lib\/issue-relation/, /^components\/workspace\/issue-relations\.tsx$/], specs: ['relations.spec.ts'] },
  { area: 'active agents', paths: [/^lib\/active-agents\./], specs: ['active-agents.spec.ts'] },
  { area: 'agent ui', paths: [/^lib\/agent-ui[-.]/, /^lib\/legacy-chat-content\.ts$/, /^components\/workspace\/agent-(?:ui-library|generative-ui|theme|chart|report|editable-table|text-bubble|decision|citations)\.tsx$/], specs: ['agent.spec.ts', 'coordinator-choice-card.spec.ts', 'bot-image-read.spec.ts', 'e2b-machine-name.spec.ts'] },
]
export const BROWSER_SCOPED_SPECS = Object.freeze([...new Set(SCOPED_BROWSER.flatMap(rule => rule.specs))].sort())
const PERFORMANCE_SPECS = ['tests/e2e/navigation-performance.spec.ts', 'tests/e2e/agent-performance.spec.ts']
/** Paths the performance budgets measure: navigation shell, settings and saved history. */
const PERFORMANCE_PATHS = [
  /^components\/(?:app-shell|app-sidebar|nav-main|nav-secondary|nav-user)\.tsx$/, /^components\/ui\/sidebar\.tsx$/,
  /^components\/settings\//, /^app\/\[locale\]\/settings\//, /^lib\/settings-(?:navigation|sections)\.ts$/,
  /^components\/workspace\/agent-conversation\.tsx$/, /^lib\/agent-history\.ts$/, /^next\.config\./,
]
export const BROWSER_SPEC_NAME = /^[a-z0-9][a-z0-9-]*\.spec\.ts$/
const touchesPerformance = files => files.some(file => PERFORMANCE_SPECS.includes(file) || PERFORMANCE_PATHS.some(pattern => pattern.test(file)))

/** No dependency graph guess: unknown paths run smoke; mapped paths add whole area specs. */
export function browserPlan(files, { unsafeModes = false, integration = false, mainPush = false, specExists = name => existsSync(`tests/e2e/${name}`) } = {}) {
  const full = performance => ({ tier: 'full', specs: [], performance })
  if (integration) return full(true)
  if (unsafeModes || !files.length) return full(mainPush || touchesPerformance(files))
  if (isDocsOnly(files)) return { tier: 'docs', specs: [], performance: false }
  if (mainPush) return { tier: 'main', specs: [], performance: false }
  const specs = new Set()
  for (const file of files) {
    if (isDocsOnly([file]) || BROWSER_INFRA_FILES.includes(file)) continue
    // An edited spec runs whole, next to smoke; shared fixtures are covered by smoke.
    if (file.startsWith('tests/e2e/')) {
      const name = file.slice('tests/e2e/'.length)
      if (BROWSER_SPEC_NAME.test(name) && specExists(name)) specs.add(name)
      continue
    }
    for (const rule of SCOPED_BROWSER) if (rule.paths.some(pattern => pattern.test(file))) for (const spec of rule.specs) specs.add(spec)
  }
  return { tier: specs.size ? 'targeted' : 'smoke', specs: [...specs].sort(), performance: touchesPerformance(files) }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
