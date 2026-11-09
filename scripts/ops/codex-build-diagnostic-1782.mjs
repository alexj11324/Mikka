/** One fixed deleted build, GET only; no templates, VMs, models or app session. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { diagnoseExistingBuild, FINALIZE_DIAGNOSTIC } from './workspace-private-acceptance.mjs'

export const OPS_PARENT = '9cd289ebe5b67cec4ea243cc11ce5fd24de9501a'
export const TARGET = Object.freeze({
  runId: '42694495556', runAttempt: '1', opsSource: '9cd289ebe5b67cec4ea243cc11ce5fd24de9501a',
  sourceCommit: 'b315f01116d64bc8a7cc1ef4312e4d14e7790dbb', sourceTree: '95f69cec928307e837e3e19fd401100ed7a90117',
  workerSha: '300c7be89fb2bbb701e29d4c74ec7962694613e1',
  templateId: 'gyx8q8k5izwymqtv36rj', buildId: '5e5fef90-c723-406a-9839-8868485fdbe8',
  artifactId: 13708184048, artifactSha256: '151e05c0ba67c292672277bd6ecdb2c5b89e67251cbf47482575e05b241e18af',
})
const DIRECTORY = 'workspace-codex-diagnostic-source'
const check = (condition, code) => { if (!condition) throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 65536 }).trim()
const CODES = new Set(['diagnostic_context_refused', 'diagnostic_parent_refused', 'diagnostic_target_refused',
  'diagnostic_source_refused', 'diagnostic_checkout_refused', 'diagnostic_saved_source_refused', 'diagnostic_arguments_refused'])

export function assertTarget(target = FINALIZE_DIAGNOSTIC) {
  check(isDeepStrictEqual(target, TARGET), 'diagnostic_target_refused')
}

export function guardContext(env, event, head, parents, dirty) {
  workflowGuard(env)
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_RUN_ATTEMPT === '1'
    && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324' && env.GITHUB_JOB === 'codex_deleted_build_readonly'
    && env.GITHUB_WORKFLOW_REF === 'alexj11324/Mikka/.github/workflows/issue1782-codex-build-diagnostic.yml@refs/heads/ops/self-hosted-vault-closeout-20261108'
    && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && head === env.GITHUB_SHA
    && event.forced === false && event.deleted === false && dirty === false, 'diagnostic_context_refused')
  check(event.before === OPS_PARENT && isDeepStrictEqual(parents, [OPS_PARENT]), 'diagnostic_parent_refused')
  assertTarget()
}

export function guardProduct({ source, tree, dirty, workerSha, nodeMajor }) {
  check(source === TARGET.sourceCommit && tree === TARGET.sourceTree && dirty === false
    && workerSha === TARGET.workerSha && nodeMajor === '24', 'diagnostic_source_refused')
}

export function publicFailure(error) {
  return { event: 'fixed_codex_diagnostic_refused', code: CODES.has(error?.message) ? error.message : 'diagnostic_failed' }
}

async function source(env) {
  const root = process.cwd(), directory = resolve(root, DIRECTORY)
  const head = git(root, 'rev-parse', 'HEAD')
  guardContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), head,
    git(root, 'show', '-s', '--format=%P', 'HEAD').split(' '),
    git(root, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)' + DIRECTORY) !== '')
  check(await realpath(directory) === directory && git(directory, 'rev-parse', '--show-toplevel') === directory,
    'diagnostic_checkout_refused')
  const product = { source: git(directory, 'rev-parse', 'HEAD'), tree: git(directory, 'rev-parse', 'HEAD^{tree}'),
    dirty: git(directory, 'status', '--porcelain', '--untracked-files=all') !== '', nodeMajor: process.versions.node.split('.')[0] }
  // The immutable checkout is checked before running its existing pure worker hash operation.
  check(product.source === TARGET.sourceCommit && product.tree === TARGET.sourceTree
    && product.dirty === false && product.nodeMajor === '24', 'diagnostic_source_refused')
  const workerSha = execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', TARGET.sourceCommit],
    { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }).trim()
  guardProduct({ ...product, workerSha })
  check(git(directory, 'status', '--porcelain', '--untracked-files=all') === '', 'diagnostic_source_refused')
  const files = Object.fromEntries(await Promise.all(['scripts/ops/codex-build-diagnostic-1782.mjs',
    'scripts/ops/workspace-private-acceptance.mjs', '.github/workflows/issue1782-codex-build-diagnostic.yml'].map(async path =>
    [path, hash(await readFile(resolve(root, path)))])))
  return { version: 1, diagnosticSource: head, diagnosticTree: git(root, 'rev-parse', 'HEAD^{tree}'),
    diagnosticRunId: env.GITHUB_RUN_ID, diagnosticRunAttempt: '1', sourceVerified: true,
    target: TARGET, files, workerSha, scope: 'existing_deleted_build_read_only', resourcesCreated: false, mutationsPerformed: false }
}

async function save(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

async function main(operation) {
  check(['check', 'diagnose'].includes(operation) && process.argv.length === 3, 'diagnostic_arguments_refused')
  const binding = await source(process.env), output = resolve(process.env.RUNNER_TEMP, 'codex-build-diagnostic-1782')
  if (operation === 'check') {
    await save(resolve(output, 'source.json'), binding)
    console.log(JSON.stringify({ sourceVerified: true, targetRunId: TARGET.runId, resourcesCreated: false })); return
  }
  const saved = JSON.parse(await readFile(resolve(output, 'source.json'), 'utf8'))
  check(isDeepStrictEqual(saved, binding), 'diagnostic_saved_source_refused')
  // This fixed function performs only bounded GETs to the one compiled target.
  // It emits closed categories/counters; raw messages and credential never leave memory.
  const report = { ...binding, ...await diagnoseExistingBuild(process.env.E2B_API_KEY) }
  await save(resolve(output, 'diagnostic.json'), report)
  console.log(JSON.stringify({ outcome: report.outcome, complete: report.complete, failure: report.failure,
    requests: report.requests, pages: report.pages, entries: report.entries, resourcesCreated: false }))
  if (report.outcome !== 'available') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
}
