import test from 'node:test'
import assert from 'node:assert/strict'
import { ADMISSION, validateAdmission } from './issue1512-native-live-diagnostic-guard.mjs'

function fixture() {
  const files = [
    { path: ADMISSION.workflowPath, sha: 'a'.repeat(40), base: null, bytes: 100, sha256: 'a'.repeat(64), mode: '100644' },
    { path: ADMISSION.guardPath, sha: 'b'.repeat(40), base: null, bytes: 200, sha256: 'b'.repeat(64), mode: '100644' },
    { path: 'lib/swr/read-observer.ts', sha: 'c'.repeat(40), base: 'd'.repeat(40), bytes: 300, sha256: 'c'.repeat(64), mode: '100644' },
  ]
  const invariants = [{ path: 'apps/desktop/test/run-acceptance.mjs', sha: 'e'.repeat(40) }]
  const manifest = { version: 1, enabled: true, requestId: ADMISSION.requestId, repository: ADMISSION.repository,
    branch: ADMISSION.branch, message: ADMISSION.message, baseSha: ADMISSION.baseSha, baseTree: ADMISSION.baseTree,
    productionCases: 0, formalBudgetAcceptance: false, modelCallsAllowed: false, additionalBusinessQueriesAllowed: false,
    files, invariants, runner: 'macos-26',
    acceptanceCommand: 'node apps/desktop/test/environment.mjs -- node apps/desktop/test/run-acceptance.mjs bundled-smoke parity lifecycle',
    diagnosticTestCommand: 'node --test apps/desktop/test/native-read-diagnostic.test.mjs' }
  const environment = { repository: ADMISSION.repository, ref: 'refs/heads/' + ADMISSION.branch,
    event: 'push', attempt: '1', runId: '12345', sha: 'f'.repeat(40) }
  const source = { head: environment.sha, parent: ADMISSION.baseSha, parentsCount: 1,
    baseTree: ADMISSION.baseTree, message: ADMISSION.message, clean: true,
    changed: [...files.map(file => file.path), ADMISSION.manifestPath],
    files: files.map(file => ({ ...file, worktreeSha: file.sha })),
    invariants: invariants.map(file => ({ ...file, base: file.sha })) }
  return { manifest, environment, source }
}
function refuses(change, code) {
  const f = fixture(); change(f)
  assert.throws(() => validateAdmission(f.manifest, f.environment, f.source), { message: code })
}
test('one immutable diagnostic source is admitted with no formal or production claim', () => {
  const f = fixture()
  const actual = validateAdmission(f.manifest, f.environment, f.source)
  assert.equal(actual.status, 'ADMITTED_DIAGNOSTIC_ONLY')
  assert.equal(actual.formalBudgetAcceptance, false)
  assert.equal(actual.productionCases, 0)
  assert.equal(actual.attempt, 1)
  assert.equal(actual.head, f.environment.sha)
  assert.equal(actual.boundFiles, 3)
})
for (const [label, change] of [
  ['another repository', f => { f.environment.repository = 'another/repo' }],
  ['another branch', f => { f.environment.ref = 'refs/heads/main' }],
  ['manual event', f => { f.environment.event = 'workflow_dispatch' }],
  ['rerun attempt', f => { f.environment.attempt = '2' }],
  ['unknown run id', f => { f.environment.runId = '' }],
  ['invalid source id', f => { f.environment.sha = 'unknown' }],
]) test('refuses ' + label + ' before admission', () => refuses(change, 'DIAGNOSTIC_EVENT_REFUSAL'))
for (const [label, change] of [
  ['disabled manifest', f => { f.manifest.enabled = false }],
  ['another request', f => { f.manifest.requestId = 'changed' }],
  ['another base', f => { f.manifest.baseSha = '0'.repeat(40) }],
  ['production case', f => { f.manifest.productionCases = 1 }],
  ['formal budget substitution', f => { f.manifest.formalBudgetAcceptance = true }],
  ['model permission', f => { f.manifest.modelCallsAllowed = true }],
  ['additional query permission', f => { f.manifest.additionalBusinessQueriesAllowed = true }],
]) test('refuses ' + label, () => refuses(change, 'DIAGNOSTIC_MANIFEST_REFUSAL'))
for (const [label, change] of [
  ['different checkout', f => { f.source.head = '1'.repeat(40) }],
  ['different parent', f => { f.source.parent = '1'.repeat(40) }],
  ['merge parent', f => { f.source.parentsCount = 2 }],
  ['wrong base tree', f => { f.source.baseTree = '1'.repeat(40) }],
  ['changed admission message', f => { f.source.message = 'closed' }],
]) test('refuses ' + label, () => refuses(change, 'DIAGNOSTIC_SOURCE_REFUSAL'))
for (const [label, change] of [
  ['unlisted extra file', f => { f.source.changed.push('lib/auth/unsafe.ts') }],
  ['missing listed file', f => { f.source.changed.pop() }],
  ['dirty worktree', f => { f.source.clean = false }],
]) test('refuses ' + label, () => refuses(change, 'DIAGNOSTIC_TREE_REFUSAL'))
for (const [label, change] of [
  ['modified worktree bytes', f => { f.source.files[0].worktreeSha = '1'.repeat(40) }],
  ['different file hash', f => { f.source.files[1].sha = '1'.repeat(40) }],
  ['different original file', f => { f.source.files[2].base = '1'.repeat(40) }],
  ['changed byte count', f => { f.source.files[1].bytes++ }],
  ['executable mode', f => { f.source.files[1].mode = '100755' }],
  ['different SHA256', f => { f.source.files[1].sha256 = '1'.repeat(64) }],
]) test('refuses ' + label, () => refuses(change, 'DIAGNOSTIC_FILE_BINDING_REFUSAL'))
test('refuses duplicate manifest paths', () => refuses(f => { f.manifest.files.push({ ...f.manifest.files[0] }) }, 'DIAGNOSTIC_FILE_ENTRY_REFUSAL'))
test('refuses path traversal', () => refuses(f => { f.manifest.files[0].path = '../outside' }, 'DIAGNOSTIC_FILE_ENTRY_REFUSAL'))
test('refuses changed unchanged-source invariant', () => refuses(f => { f.source.invariants[0].sha = '1'.repeat(40) }, 'DIAGNOSTIC_INVARIANT_REFUSAL'))
test('refuses acceptance command with omitted original suite', () => refuses(f => { f.manifest.acceptanceCommand = 'node apps/desktop/test/run-acceptance.mjs lifecycle' }, 'DIAGNOSTIC_COMMAND_REFUSAL'))
test('refuses nonnative runner', () => refuses(f => { f.manifest.runner = 'ubuntu-latest' }, 'DIAGNOSTIC_COMMAND_REFUSAL'))
