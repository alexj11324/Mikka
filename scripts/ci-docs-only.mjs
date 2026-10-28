// Tells CI whether a change only touches documentation.
//
// The branch protection on main requires four status checks. A workflow that
// is skipped by `paths-ignore` never reports them, so the pull request stays
// blocked forever. Instead the workflows always run and use this output to
// skip their heavy jobs; a small gate job keeps the required check names and
// reports success for a documentation-only change.
//
// Run from a checkout with full history:
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
  /^docs\//,
  /^tasks\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
  /^\.github\/pull_request_template\.md$/,
  /^scripts\/diagram-svg\.mjs$/,
  /^scripts\/generate-diagrams\.mjs$/,
]

export function isDocsOnly(files) {
  return files.length > 0 && files.every(file => DOCS_ONLY.some(pattern => pattern.test(file)))
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
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRD', `${base}...${head}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out.split('\n').map(file => file.trim()).filter(Boolean)
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
      base = payload.before
      head = payload.after
    }
  }

  const emptySha = /^0+$/
  if (!base || !head || emptySha.test(base) || emptySha.test(head)) return output(false, 'no comparable range')

  let files
  try {
    files = changedFiles(base, head)
  } catch (error) {
    // Fail open: an unknown base must run the full suites, never skip them.
    return output(false, `git diff failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  output(isDocsOnly(files), files.length ? `${files.length} changed file(s): ${files.join(', ')}` : 'no changed files')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
