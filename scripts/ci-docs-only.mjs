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

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
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

function output(docsOnly, reason) {
  const value = docsOnly ? 'true' : 'false'
  console.log(`docs_only=${value} (${reason})`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${value}\n`)
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
      return output(false, 'integration run')
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
  if (!base || !head || emptySha.test(base) || emptySha.test(head)) return output(false, 'no comparable range')

  let result
  try {
    // Do not trust a force-pushed or unrelated main history for postsubmit skips.
    if (mainPush) execFileSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' })
    result = changedFiles(base, head)
  } catch (error) {
    // Unknown histories and failed comparisons must run the full suites.
    return output(false, `git diff failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const reason = result.files.length
    ? `${result.files.length} changed file(s)`
    : 'no changed files'
  const docsOnly = isDocsOnly(result.files, result.unsafeModes)
  output(docsOnly, result.unsafeModes ? `${reason}; non-regular path or unmerged entry` : reason)
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
