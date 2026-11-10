// TEMPORARY issue #1512 diagnostic admission; never a product acceptance gate.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADMISSION = Object.freeze({
  repository: 'alexj11324/Mikka',
  branch: 'ops/1512-native-live-diagnostic-20261110',
  requestId: '6e1a5e12-269f-44be-9ef5-a05d6f5088c1',
  message: 'ci: admit issue1512 native read diagnostic 6e1a5e12-269f-44be-9ef5-a05d6f5088c1',
  baseSha: '5f3598029033b83ee72c88ea6c49955205eecab2',
  baseTree: 'b2559ddd822059f1b69fa711d037f654a790fd2a',
  manifestPath: '.github/issue1512-native-live-diagnostic.json',
  workflowPath: '.github/workflows/issue1512-native-live-diagnostic.yml',
  guardPath: 'scripts/ops/issue1512-native-live-diagnostic-guard.mjs',
})
const sha1 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = code => { throw new Error(code) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export function validateAdmission(manifest, environment, source) {
  if (environment.repository !== ADMISSION.repository || environment.ref !== 'refs/heads/' + ADMISSION.branch
    || environment.event !== 'push' || environment.attempt !== '1'
    || !/^[1-9][0-9]*$/.test(environment.runId ?? '') || !sha1(environment.sha)) fail('DIAGNOSTIC_EVENT_REFUSAL')
  if (!manifest || manifest.version !== 1 || manifest.enabled !== true
    || manifest.requestId !== ADMISSION.requestId || manifest.repository !== ADMISSION.repository
    || manifest.branch !== ADMISSION.branch || manifest.message !== ADMISSION.message
    || manifest.baseSha !== ADMISSION.baseSha || manifest.baseTree !== ADMISSION.baseTree
    || manifest.productionCases !== 0 || manifest.formalBudgetAcceptance !== false
    || manifest.modelCallsAllowed !== false || manifest.additionalBusinessQueriesAllowed !== false) fail('DIAGNOSTIC_MANIFEST_REFUSAL')
  if (source.head !== environment.sha || source.parent !== ADMISSION.baseSha || source.parentsCount !== 1
    || source.baseTree !== ADMISSION.baseTree || source.message !== ADMISSION.message) fail('DIAGNOSTIC_SOURCE_REFUSAL')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 40
    || !Array.isArray(source.files) || !Array.isArray(source.changed)) fail('DIAGNOSTIC_FILES_REFUSAL')
  const paths = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || p === '')
      || paths.has(file.path) || file.path === ADMISSION.manifestPath || !sha1(file.sha)
      || !sha256(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !(file.base === null || sha1(file.base)) || file.mode !== '100644') fail('DIAGNOSTIC_FILE_ENTRY_REFUSAL')
    paths.add(file.path)
    const actual = source.files.find(entry => entry.path === file.path)
    if (!actual || actual.sha !== file.sha || actual.base !== file.base || actual.sha256 !== file.sha256
      || actual.bytes !== file.bytes || actual.mode !== file.mode || actual.worktreeSha !== file.sha) fail('DIAGNOSTIC_FILE_BINDING_REFUSAL')
  }
  if (!paths.has(ADMISSION.workflowPath) || !paths.has(ADMISSION.guardPath)
    || source.files.length !== manifest.files.length
    || !same([...paths, ADMISSION.manifestPath].sort(), [...source.changed].sort())
    || source.clean !== true) fail('DIAGNOSTIC_TREE_REFUSAL')
  if (!Array.isArray(manifest.invariants) || !manifest.invariants.length) fail('DIAGNOSTIC_INVARIANTS_REFUSAL')
  for (const invariant of manifest.invariants) {
    if (!invariant || typeof invariant.path !== 'string' || !sha1(invariant.sha)
      || !source.invariants.some(actual => actual.path === invariant.path && actual.sha === invariant.sha && actual.base === invariant.sha)) fail('DIAGNOSTIC_INVARIANT_REFUSAL')
  }
  if (manifest.acceptanceCommand !== 'node apps/desktop/test/environment.mjs -- node apps/desktop/test/run-acceptance.mjs bundled-smoke parity lifecycle'
    || manifest.runner !== 'macos-26' || manifest.diagnosticTestCommand !== 'node --test apps/desktop/test/native-read-diagnostic.test.mjs') fail('DIAGNOSTIC_COMMAND_REFUSAL')
  return Object.freeze({ version: 1, status: 'ADMITTED_DIAGNOSTIC_ONLY', requestId: ADMISSION.requestId,
    repository: environment.repository, branch: ADMISSION.branch, runId: environment.runId, attempt: 1,
    head: environment.sha, baseSha: source.parent, baseTree: source.baseTree,
    changedFiles: source.changed.length, boundFiles: manifest.files.length,
    invariantFiles: manifest.invariants.length, productionCases: 0, formalBudgetAcceptance: false })
}

function git(...args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trimEnd() }
function gitEntry(ref, path) {
  const line = git('ls-tree', ref, '--', path)
  if (!line) return null
  const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(line)
  if (!match || match[3] !== path) fail('DIAGNOSTIC_GIT_ENTRY_REFUSAL')
  return { mode: match[1], sha: match[2] }
}
export function main() {
  const environment = { repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF,
    event: process.env.GITHUB_EVENT_NAME, attempt: process.env.GITHUB_RUN_ATTEMPT,
    runId: process.env.GITHUB_RUN_ID, sha: process.env.GITHUB_SHA }
  // Reject the surface before loading any candidate-controlled path.
  if (environment.repository !== ADMISSION.repository || environment.ref !== 'refs/heads/' + ADMISSION.branch
    || environment.event !== 'push' || environment.attempt !== '1') fail('DIAGNOSTIC_EVENT_REFUSAL')
  const manifest = JSON.parse(readFileSync(ADMISSION.manifestPath, 'utf8'))
  if (!Array.isArray(manifest.files) || manifest.files.length > 40) fail('DIAGNOSTIC_FILES_REFUSAL')
  const parentLine = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')
  const source = { head: git('rev-parse', 'HEAD'), parent: parentLine[1], parentsCount: parentLine.length - 1,
    baseTree: git('rev-parse', ADMISSION.baseSha + '^{tree}'),
    message: git('show', '-s', '--format=%B', 'HEAD'),
    changed: git('diff', '--name-only', '--no-renames', ADMISSION.baseSha, 'HEAD').split('\n').filter(Boolean),
    clean: git('status', '--porcelain').length === 0,
    files: manifest.files.map(file => {
      if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || p === '')) fail('DIAGNOSTIC_FILE_ENTRY_REFUSAL')
      const bytes = readFileSync(file.path)
      const actual = gitEntry('HEAD', file.path), base = gitEntry(ADMISSION.baseSha, file.path)
      if (!actual) fail('DIAGNOSTIC_GIT_ENTRY_REFUSAL')
      return { path: file.path, ...actual, base: base?.sha ?? null, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        worktreeSha: createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex') }
    }),
    invariants: (manifest.invariants ?? []).map(file => ({ path: file.path,
      sha: gitEntry('HEAD', file.path)?.sha, base: gitEntry(ADMISSION.baseSha, file.path)?.sha }))
  }
  const receipt = validateAdmission(manifest, environment, source)
  mkdirSync('.cache/issue1512-native-diagnostic', { recursive: true, mode: 0o700 })
  writeFileSync('.cache/issue1512-native-diagnostic/admission.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt))
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
