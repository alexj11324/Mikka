import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertArtifactReference, cleanupIdentity, CLEANUP_IDENTITY_MAX_BYTES, readRuntimeReport,
  reportDigest, templateModels, templateModelsDigest } from './runtime-report.mjs'

const expected = { sourceCommit: 'a'.repeat(40), workerSha: 'b'.repeat(40), runId: '123456', runAttempt: '2' }
const fixture = () => ({ sourceCommit: expected.sourceCommit, workerSha: expected.workerSha,
  templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, {
    name: `mikka-${expected.sourceCommit.slice(0, 12)}-${expected.runId}-${expected.runAttempt}-${kind}`,
    baseTemplate: kind, templateId: `${kind}-candidate`, buildId: `build-${kind}`, preinstalled: true,
    models: [{ harness: kind, models: ['measured-model'] }],
    conservation: { before: { entries: 1200, sha256: 'c'.repeat(64) }, after: { entries: 1200, sha256: 'c'.repeat(64) },
      preserved: Array.from({ length: 1200 }, (_, n) => ({ path: `/official/${kind}/${n}`, sha256: 'c'.repeat(64) })) },
  }])) })

function withReport(t, report = fixture()) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'candidates.json'), bytes = Buffer.from(JSON.stringify(report) + '\n')
  writeFileSync(path, bytes, { mode: 0o600 })
  return { dir, path, bytes, report, expected: { ...expected, sha256: reportDigest(bytes) } }
}

test('a report larger than the failing 310446-byte payload remains byte-identical through the real file CLI', t => {
  const f = withReport(t)
  assert.ok(f.bytes.length > 310446)
  assert.deepEqual(readRuntimeReport(f.path, f.expected), f.report)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./runtime-report.mjs', import.meta.url)), 'verify', f.path], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_SHA: expected.sourceCommit, SOURCE_SHA: expected.workerSha,
      GITHUB_RUN_ID: expected.runId, GITHUB_RUN_ATTEMPT: expected.runAttempt, RUNTIME_REPORT_ARTIFACT_ID: '123', RUNTIME_REPORT_SHA256: f.expected.sha256 },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).sha256, f.expected.sha256)
  assert.doesNotMatch(result.stdout, /official\/|measured-model/)
  assert.deepEqual(readFileSync(f.path), f.bytes, 'the transport does not rewrite, truncate or normalize the proof')
})

test('an immutable reference accepts one numeric ID and a byte digest, never a list or an empty download selector', () => {
  assertArtifactReference({ artifactId: '13557755477', sha256: 'a'.repeat(64) })
  for (const artifactId of ['', '1,2', '1\n2', '0', '-1', 'latest', '9007199254740992', undefined])
    assert.throws(() => assertArtifactReference({ artifactId, sha256: 'a'.repeat(64) }), /artifact_id_invalid/)
  for (const sha256 of ['', 'a'.repeat(40), 'sha256:' + 'a'.repeat(64), undefined])
    assert.throws(() => assertArtifactReference({ artifactId: '123', sha256 }), /digest_invalid/)
})

test('changed bytes and foreign source or worker are refused before the report can reach a gate', t => {
  const f = withReport(t)
  assert.throws(() => readRuntimeReport(f.path, { ...f.expected, sha256: 'd'.repeat(64) }), /digest_mismatch/)
  for (const patch of [{ sourceCommit: 'd'.repeat(40) }, { workerSha: 'd'.repeat(40) }])
    assert.throws(() => readRuntimeReport(f.path, { ...f.expected, ...patch }), /source_mismatch/)
  assert.throws(() => readRuntimeReport(f.path, { ...f.expected, sha256: '' }), /digest_invalid/)
  assert.throws(() => readRuntimeReport('', f.expected), /file_required/)
  assert.throws(() => readRuntimeReport(f.path + '-missing', f.expected), error => error.message === 'runtime_report_read_failed' && error.cause?.code === 'ENOENT')
})

test('a partial rerun cannot reuse a previous attempt or another run as subscription/publication proof', t => {
  const f = withReport(t)
  for (const patch of [{ runAttempt: '1' }, { runAttempt: '3' }, { runId: '999' }])
    assert.throws(() => readRuntimeReport(f.path, { ...f.expected, ...patch }), /attempt_mismatch/)
  for (const patch of [{ sourceCommit: 'main' }, { runId: '' }, { runAttempt: '0' }, { workerSha: undefined }])
    assert.throws(() => readRuntimeReport(f.path, { ...f.expected, ...patch }), /expected_identity_invalid/)
})

test('only short cleanup identities cross the failure boundary, independent of every preservation proof byte', t => {
  const f = withReport(t), text = cleanupIdentity(f.report, expected), receipt = JSON.parse(text)
  assert.ok(Buffer.byteLength(text) < CLEANUP_IDENTITY_MAX_BYTES)
  assert.deepEqual(Object.keys(receipt).sort(), ['version', 'sourceCommit', 'runId', 'runAttempt', 'templates'].sort())
  for (const kind of ['desktop', 'claude', 'codex']) {
    assert.deepEqual(Object.keys(receipt.templates[kind]).sort(), ['baseTemplate', 'name', 'templateId'])
    assert.equal(receipt.templates[kind].templateId, f.report.templates[kind].templateId)
  }
  assert.doesNotMatch(text, /preserved|models|sha256/)
  assert.throws(() => cleanupIdentity(f.report, { ...expected, runAttempt: '3' }), /attempt_mismatch/)
})

test('model catalogue digest binds the original build while the full report remains in a file', () => {
  const report = fixture(), original = templateModelsDigest(report)
  assert.equal(original.length, 64)
  assert.deepEqual(Object.keys(templateModels(report)), ['desktop', 'claude', 'codex'])
  report.templates.codex.models[0].models.push('not-measured-at-build')
  assert.notEqual(templateModelsDigest(report), original)
})

test('model digests ignore JSON object key order but preserve array order and model values', () => {
  const report = fixture()
  report.templates.codex.models[0].modelSlots = [{ id: 'one', effort: { medium: true, high: false } }, { id: 'two' }]
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverse(value[key])])) : value
  assert.equal(templateModelsDigest(report), templateModelsDigest(reverse(report)))
  const changed = structuredClone(report)
  changed.templates.codex.models[0].modelSlots.reverse()
  assert.notEqual(templateModelsDigest(report), templateModelsDigest(changed))
})

function workflowNodeScript(file, argument) {
  const lines = readFileSync(new URL('../../.github/workflows/' + file, import.meta.url), 'utf8').split('\n')
  const start = lines.findIndex(line => line.includes(`node --input-type=module - "$RUNNER_TEMP/${argument}" <<'JS'`))
  assert.ok(start >= 0, `actual workflow script for ${argument}`)
  const end = lines.findIndex((line, i) => i > start && line.trim() === 'JS')
  assert.ok(end > start)
  const indent = lines[start].match(/^ */)[0].length
  return lines.slice(start + 1, end).map(line => line.slice(indent)).join('\n')
}

test('the actual workflow producer and pre-publication scripts keep large proofs out of every job output', t => {
  const f = withReport(t), output = join(f.dir, 'outputs')
  const env = { PATH: process.env.PATH, GITHUB_SHA: expected.sourceCommit, SOURCE_SHA: expected.workerSha,
    GITHUB_RUN_ID: expected.runId, GITHUB_RUN_ATTEMPT: expected.runAttempt, GITHUB_OUTPUT: output,
    TEMPLATE_MODELS_SHA256: templateModelsDigest(f.report) }
  const run = (workflow, argument, extra = {}) => spawnSync(process.execPath, ['--input-type=module', '-', f.path], {
    input: workflowNodeScript(workflow, argument), encoding: 'utf8', env: { ...env, ...extra },
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
  })
  const build = run('e2b-template.yml', 'candidates.json')
  assert.equal(build.status, 0, build.stderr)
  const lines = readFileSync(output, 'utf8').trim().split('\n')
  const values = Object.fromEntries(lines.map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  assert.deepEqual(Object.keys(values).sort(), ['source-sha', 'template-models-sha256', 'candidate-sha256', 'candidate-identities'].sort())
  assert.equal(values['candidate-sha256'], f.expected.sha256)
  assert.equal(values['template-models-sha256'], templateModelsDigest(f.report))
  assert.equal(values['candidate-identities'], cleanupIdentity(f.report, expected))
  assert.ok(lines.every(line => Buffer.byteLength(line) < CLEANUP_IDENTITY_MAX_BYTES))
  const accepted = run('e2b-official-runtime.yml', 'accepted.json')
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.notEqual(run('e2b-official-runtime.yml', 'accepted.json', { GITHUB_RUN_ATTEMPT: '3' }).status, 0)
  assert.notEqual(run('e2b-official-runtime.yml', 'accepted.json', { TEMPLATE_MODELS_SHA256: 'd'.repeat(64) }).status, 0)
  writeFileSync(output, '')
  const release = run('e2b-official-runtime.yml', 'release.json')
  assert.equal(release.status, 0, release.stderr)
  const releaseLines = readFileSync(output, 'utf8').trim().split('\n')
  assert.equal(releaseLines.length, 2)
  assert.equal(releaseLines[0], `release-sha256=${f.expected.sha256}`)
  assert.ok(releaseLines.every(line => Buffer.byteLength(line) < CLEANUP_IDENTITY_MAX_BYTES))
  assert.deepEqual(readFileSync(f.path), f.bytes)
})

test('malformed report text keeps its error cause but never reaches CLI diagnostics', t => {
  const f = withReport(t), bytes = Buffer.from('{"private-marker-invalid-json')
  writeFileSync(f.path, bytes)
  const sha256 = reportDigest(bytes)
  assert.throws(() => readRuntimeReport(f.path, { ...f.expected, sha256 }), error => error.message === 'runtime_report_json_invalid' && error.cause instanceof SyntaxError)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./runtime-report.mjs', import.meta.url)), 'verify', f.path], {
    encoding: 'utf8', env: { PATH: process.env.PATH, RUNTIME_REPORT_ARTIFACT_ID: '123', RUNTIME_REPORT_SHA256: sha256 },
  })
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stderr), { event: 'runtime_report_refused', code: 'runtime_report_json_invalid' })
  assert.doesNotMatch(result.stdout + result.stderr, /private-marker|candidates\.json/)
})
