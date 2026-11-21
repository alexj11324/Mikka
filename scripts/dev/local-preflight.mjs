import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA_RE = /^[a-f\d]{40}$/
const MANUAL = 'Product behavior must be exercised through the real isolated application; CI green is not acceptance.'

export function argsFrom(argv) {
  const options = { command: 'plan', base: 'origin/main', tests: [], accept: null, report: null, reason: null }
  const choices = new Set(['plan', 'check', 'ready', 'verify-ready'])
  for (const arg of argv) {
    if (choices.has(arg)) { options.command = arg; continue }
    if (arg.startsWith('--base=')) options.base = arg.slice(7)
    else if (arg.startsWith('--test=')) options.tests.push(arg.slice(7))
    else if (arg.startsWith('--accept=')) options.accept = arg.slice(9)
    else if (arg.startsWith('--report=')) options.report = arg.slice(9)
    else if (arg.startsWith('--no-product-change=')) options.reason = arg.slice(20)
    else throw new Error(`Unknown option ${arg}`)
  }
  if (options.reason && (options.accept || options.report)) throw new Error('Cannot waive acceptance and supply acceptance simultaneously')
  return options
}

function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 10_000_000 }) }
  catch (error) { throw new Error(`git ${args[0]} failed (${error.status ?? error.code}): ${(error.stderr || '').toString().slice(0,300)}`, { cause: error }) }
}

function diffEntries(raw) {
  if (!raw) return []
  const parts = raw.split('\0'); parts.pop()
  const changes = []
  for (let i = 0; i < parts.length; i += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([a-f\d]{40}) ([a-f\d]{40}) ([A-Z]\d*)$/.exec(parts[i] || '')
    const path = parts[i + 1]
    if (!path || !header) throw new Error('Malformed git --raw -z output')
    const [, oldMode, mode, oldObject, newObject, status] = header
    changes.push({ path, status: status[0], oldMode, mode, oldObject, newObject })
  }
  return changes
}

export function changesFromGit(root, base = 'origin/main') {
  // A nonexistent/missing base fails closed; never silently inspect only HEAD.
  git(root, ['rev-parse', '--verify', `${base}^{commit}`])
  const head = git(root, ['rev-parse', 'HEAD']).trim()
  if (!SHA_RE.test(head)) throw new Error('Invalid HEAD SHA')
  const ancestor = git(root, ['merge-base', base, 'HEAD']).trim()
  const source = [
    git(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', `${ancestor}..HEAD`]),
    git(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', '--cached']),
    git(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z']),
  ]
  const entries = source.flatMap(diffEntries)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).map(path => {
    const file = lstatSync(join(root, path))
    let mode = null
    if (file.isSymbolicLink()) mode = '120000'
    else if (file.isFile()) mode = file.mode & 0o100 ? '100755' : '100644'
    return { path, status: 'A', oldMode: '000000', mode }
  })
  // Preserve distinct rows from every Git layer. A later regular edit must not
  // hide an earlier mode, type or deletion; the original selector decides scope.
  const seen = new Map()
  for (const entry of [...entries, ...untracked]) {
    seen.set(JSON.stringify(entry), entry)
  }
  const changes = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
  if (changes.some(item => item.path.includes('\n'))) throw new Error('Newline paths require explicit review before Ready')
  return { head, base: ancestor, changes, clean: git(root, ['status', '--porcelain', '-z']).length === 0 }
}

export function localTaskPlan(selection, explicitTests = []) {
  const changedFiles = [...new Set(selection.files || [])]
  const scripts = selection.scripts || {}
  const suggested = [...new Set((selection.unit_tasks || [])
    .filter(t => t.reason === 'Nx reverse dependency')
    .map(t => t.command.trim())
    .filter(command => /^pnpm (?:--filter\s+\S+\s+)?[\w:-]+$/.test(command)))]
  const unknown = explicitTests.filter(name => !Object.hasOwn(scripts, name))
  if (unknown.length) throw new Error(`Unknown package script(s): ${unknown.join(', ')}`)
  const hasBehaviors = changedFiles.some(path => !/^(?:docs\/|\.github\/|\.agents\/|.*\.md$)/.test(path))
  return {
    changedFiles,
    full: Boolean(selection.full),
    docsOnly: Boolean(selection.docs_only),
    reason: selection.reasons || [],
    relevantUnits: (selection.unit_tasks || []).filter(t => t.reason === 'Nx reverse dependency').map(t => t.project),
    suggested,
    explicitTests,
    selectedDbSuites: selection.db_suites || [],
    hasBehaviors,
  }
}

export function readiness(plan, result, { reason = null } = {}) {
  if (!result.clean) throw new Error('Ready requires a clean committed worktree; do not bind uncommitted changes to HEAD')
  if (!result.changedFiles.length) throw new Error('No diff against the requested base')
  if (result.checks.length === 0 && !plan.docsOnly) throw new Error('Ready requires an actual focused local test/check')
  if (result.checks.some(check => check.exitCode !== 0)) throw new Error('Local checks failed')
  if (result.acceptance?.type === 'script' && result.acceptance.exitCode !== 0) throw new Error('Product acceptance failed')
  if (!result.acceptance && (!reason || reason.trim().length < 12)) throw new Error('Provide --accept, --report or a substantive --no-product-change reason')
  if (reason && plan.hasBehaviors && !/^(?:tooling|docs|ci|refactor|nonproduct):/i.test(reason.trim())) throw new Error('Behavior-changing code needs real product acceptance; tooling-only exception must name its scope')
  return true
}

export function runScript(root, script, scripts, executor = spawnSync) {
  if (!Object.hasOwn(scripts, script)) throw new Error(`Unknown script: ${script}`)
  const start = Date.now()
  const res = executor('pnpm', ['run', script], { cwd: root, stdio: 'inherit', shell: false })
  return { script, exitCode: res.error || res.signal ? 1 : res.status ?? 1, durationMs: Date.now() - start }
}

const hash = value => createHash('sha256').update(value).digest('hex')
export function evidencePath(root, head) { return join(root, '.cache', 'dev-local', 'local-first', `${head}.json`) }
export function evidenceIdentity(snapshot) {
  return hash(JSON.stringify({ head: snapshot.head, base: snapshot.base, files: snapshot.changes }))
}

async function currentPlan(root, options, snapshot) {
  const { buildGraph } = await import('../ci/graph.mjs')
  const { select } = await import('../ci/select.mjs')
  const graph = buildGraph(root)
  const changes = snapshot.changes.map(({ path, ...change }) => ({ file: path, ...change }))
  const selected = await select(graph, changes)
  return localTaskPlan({ ...selected, files: changes.map(item => item.file), scripts: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts }, options.tests)
}

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const options = argsFrom(argv)
  const snapshot = changesFromGit(root, options.base)
  const source = evidencePath(root, snapshot.head)
  if (options.command === 'verify-ready') {
    if (!existsSync(source)) throw new Error('No local verification for current HEAD; run ready first')
    const evidence = JSON.parse(readFileSync(source, 'utf8'))
    if (!snapshot.clean || evidence.sha !== snapshot.head || evidence.identity !== evidenceIdentity(snapshot) || evidence.ready !== true) throw new Error('Evidence is stale, dirty, or not a Ready verification')
    if (!evidence.acceptance && !evidence.waiver) throw new Error('Product acceptance evidence missing')
    if (evidence.checks.some(c => c.exitCode !== 0)) throw new Error('Evidence records a failed check')
    console.log(JSON.stringify({ ready: true, sha: evidence.sha, evidence: source }))
    return 0
  }
  const plan = await currentPlan(root, options, snapshot)
  if (options.command === 'plan') {
    console.log(JSON.stringify({ ...plan, sha: snapshot.head, base: snapshot.base, clean: snapshot.clean, guidance: MANUAL }, null, 2))
    return 0
  }
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts
  // Working loop stays focused. The Nx selector is a *suggestion*, not an
  // authorization to run the entire CI matrix on every local edit.
  if (!options.tests.length && !plan.docsOnly) throw new Error('Supply --test=<existing-pnpm-script> after inspecting plan; no automatic full-suite fallback')
  let checks = options.tests.map(script => runScript(root, script, scripts))
  const result = { version: 1, sha: snapshot.head, identity: evidenceIdentity(snapshot),
    base: snapshot.base, changedFiles: plan.changedFiles, clean: snapshot.clean,
    fullSelection: plan.full, suggestedTasks: plan.suggested, affectedDb: plan.selectedDbSuites,
    checks, acceptance: null, waiver: options.reason, ready: false, observedAt: new Date().toISOString() }
  if (options.command === 'ready') {
    if (!snapshot.clean) throw new Error('Ready requires a clean committed worktree')
    if (options.accept) result.acceptance = { type: 'script', ...runScript(root, options.accept, scripts) }
    if (options.report) {
      const report = resolve(root, options.report)
      if (!existsSync(report) || !readFileSync(report).length) throw new Error('Acceptance report missing or empty')
      if (result.acceptance) throw new Error('Choose an acceptance script OR existing report')
      result.acceptance = { type: 'report', path: options.report, sha256: hash(readFileSync(report)) }
    }
    readiness(plan, result, { reason: options.reason })
    result.ready = true
  }
  mkdirSync(join(root, '.cache', 'dev-local', 'local-first'), { recursive: true })
  writeFileSync(source, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ ...result, evidence: source, next: result.ready ? 'Paste exact SHA, local commands and acceptance report into the PR; then mark Ready.' : 'Continue local development; run ready after the source is committed.' }, null, 2))
  return checks.some(check => check.exitCode !== 0) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
