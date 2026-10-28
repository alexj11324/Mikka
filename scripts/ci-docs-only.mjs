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
// Prints `docs_only=true|false` and writes it to GITHUB_OUTPUT when set.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Paths whose changes cannot require a build or a browser test. */
const DOCS_ONLY = [
  /^docs\/.*\.md$/,
  /^tasks\/.*\.md$/,
  /^README(?:\.[^/]+)?\.md$/,
  /^LICENSE$/,
  /^\.github\/pull_request_template\.md$/,
]

export function isDocsOnly(files, unsafeModes = false) {
  return !unsafeModes && files.length > 0 && files.every(file => !/(?:^|\/)AGENTS\.md$/.test(file) && DOCS_ONLY.some(pattern => pattern.test(file)))
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

  if (!base || !head) {
    const eventName = process.env.GITHUB_EVENT_NAME
    const payload = eventPayload()
    if (eventName === 'pull_request') {
      base = payload.pull_request?.base?.sha
      head = payload.pull_request?.head?.sha
    } else if (eventName === 'merge_group') {
      base = payload.merge_group?.base_sha
      head = payload.merge_group?.head_sha
    } else if (eventName === 'push') {
      // A main push is postsubmit: always run the full suites.
      if (process.env.GITHUB_REF === 'refs/heads/main') return output(false, 'push to main')
      // Classify the whole branch against main, not just the pushed commits:
      // a docs-only last push must not hide earlier code changes.
      base = 'origin/main'
      head = process.env.GITHUB_SHA
    }
  }

  const emptySha = /^0+$/
  if (!base || !head || emptySha.test(base) || emptySha.test(head)) return output(false, 'no comparable range')

  let result
  try {
    result = changedFiles(base, head)
  } catch (error) {
    // Fail open: an unknown base must run the full suites, never skip them.
    return output(false, `git diff failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const reason = result.files.length
    ? `${result.files.length} changed file(s): ${result.files.join(', ')}`
    : 'no changed files'
  output(isDocsOnly(result.files, result.unsafeModes), result.unsafeModes ? `${reason}; non-regular path or unmerged entry` : reason)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
