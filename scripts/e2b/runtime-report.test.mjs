import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRuntimeArtifactReference, readRuntimeReport, sealRuntimeReport } from './runtime-report.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SHA = 'a'.repeat(40), WORKER = 'b'.repeat(40)
const identity = { GITHUB_SHA: SHA, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'alexj11324/Mikka' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const candidate = () => ({ sourceCommit: SHA, workerSha: WORKER,
  templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, {
    templateId: `template-${kind}`, baseTemplate: kind, preinstalled: true,
    name: `mikka-${SHA.slice(0, 12)}-123-1-${kind}`,
    // Full conservation evidence can exceed Linux's per-environment-string
    // limit. Transport must preserve every byte, including unknown proof data.
    conservation: { fixtureEvidence: 'x'.repeat(110000) },
  }])) })

function runStep(workflow, name) {
  const after = workflow.split(`      - name: ${name}\n`)[1]
  assert.ok(after, `step ${name} exists`)
  const block = after.split('\n      - ')[0]
  const script = block.match(/        run: \|\n((?:          [^\n]*\n|\n)+)/)?.[1]
  assert.ok(script, `step ${name} has a shell boundary`)
  return { block, script: script.replace(/^          /gm, '') }
}

test('the real subscription shell transports a complete 310KB+ candidate without putting it in argv or env', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-report-'))
  try {
    const bytes = Buffer.from(JSON.stringify(candidate()) + '\n')
    assert.ok(bytes.length >= 310446)
    mkdirSync(join(directory, 'runtime-candidates'))
    writeFileSync(join(directory, 'runtime-candidates/candidates.json'), bytes)
    const consumer = join(directory, 'consume.mjs'), receipt = join(directory, 'consumed.json')
    writeFileSync(consumer, `import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
      const bytes=readFileSync(process.argv[2]); writeFileSync(process.env.CONSUMED_RECEIPT,
      JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));\n`)
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/e2b-official-runtime.yml'), 'utf8')
    const step = runStep(workflow, 'Require real Claude Code and Codex subscriptions on the private candidates')
    const env = { PATH: process.env.PATH, ...identity, RUNNER_TEMP: directory, CONSUMED_RECEIPT: receipt,
      RUNTIME_REPORT_SHA256: hash(bytes), RUNTIME_WORKER_SHA: WORKER }
    if (/CANDIDATE_REPORT:/.test(step.block)) env.CANDIDATE_REPORT = bytes.toString()
    const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c',
      step.script.replace('node scripts/e2b/validate-template-subscriptions.mjs', `node "${consumer}"`)],
    { cwd: ROOT, env, encoding: 'utf8' })
    assert.equal(result.error?.code, undefined, 'the subscription process must actually start')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { bytes: bytes.length, sha256: hash(bytes) })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('artifact bytes, source, worker and same-run attempt remain bound without truncating evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-report-'))
  try {
    const file = join(directory, 'candidates.json'), report = candidate(), bytes = JSON.stringify(report) + '\n'
    writeFileSync(file, bytes)
    const sealed = sealRuntimeReport(file, { env: identity })
    assert.equal(sealed.sha256, hash(bytes)); assert.equal(sealed.bytes, Buffer.byteLength(bytes))
    assert.deepEqual(readRuntimeReport(file, { env: identity, sha256: sealed.sha256, workerSha: WORKER }), report)
    assert.equal(readFileSync(file, 'utf8'), bytes)
    assert.throws(() => readRuntimeReport(file, { env: identity }), /digest_required/)
    assert.throws(() => readRuntimeReport(file, { env: identity, sha256: 'f'.repeat(64) }), /digest_mismatch/)
    assert.throws(() => readRuntimeReport(file, { env: identity, sha256: sealed.sha256, workerSha: 'c'.repeat(40) }), /source_mismatch/)
    for (const mutate of [value => { value.sourceCommit = 'c'.repeat(40) },
      value => { value.templates.claude.name = `mikka-${SHA.slice(0, 12)}-999-1-claude` },
      value => { value.templates.claude.name = `mikka-${SHA.slice(0, 12)}-123-3-claude` }]) {
      const wrong = structuredClone(report); mutate(wrong)
      const wrongBytes = JSON.stringify(wrong); writeFileSync(file, wrongBytes)
      assert.throws(() => readRuntimeReport(file, { env: identity, sha256: hash(wrongBytes), workerSha: WORKER }),
        /runtime_report_(source|candidate_identity)_mismatch/)
    }
    assert.doesNotThrow(() => assertRuntimeArtifactReference({ artifactId: '567', sha256: sealed.sha256, workerSha: WORKER }))
    for (const artifactId of ['', '567,568', 'other-run', '0'])
      assert.throws(() => assertRuntimeArtifactReference({ artifactId, sha256: sealed.sha256, workerSha: WORKER }), /reference_invalid/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('always-cleanup reaches the exact-run finalizer after upstream failure or an unusable artifact', () => {
  const workflow = readFileSync(resolve(ROOT, '.github/workflows/e2b-official-runtime.yml'), 'utf8')
  const cleanup = workflow.slice(workflow.indexOf('\n  cleanup:'))
  assert.match(cleanup, /if: always\(\) &&/)
  assert.match(cleanup, /continue-on-error: true\n        uses: actions\/download-artifact@/)
  const step = runStep(workflow, "Close this attempt's instances and remove only its private candidates")
  for (const scenario of [
    { name: 'valid', outcome: 'success', id: '567', useReport: true, status: 0 },
    { name: 'upstream-failed-before-report', outcome: 'skipped', id: '', useReport: false, status: 0 },
    { name: 'download-failed', outcome: 'failure', id: '567', useReport: false, status: 1 },
    { name: 'digest-mismatch', outcome: 'success', id: '567', useReport: false, status: 1 },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-cleanup-'))
    try {
      const bytes = JSON.stringify(candidate()) + '\n', receipt = join(directory, 'called.json')
      mkdirSync(join(directory, 'runtime-candidates'))
      writeFileSync(join(directory, 'runtime-candidates/candidates.json'), bytes)
      mkdirSync(join(directory, 'e2b-cleanup/bin'), { recursive: true })
      writeFileSync(join(directory, 'e2b-cleanup/bin/python'), `#!${process.execPath}
        const fs=require('node:fs'),crypto=require('node:crypto'); const args=process.argv.slice(2);
        const index=args.indexOf('--report'), file=index<0?null:args[index+1];
        fs.writeFileSync(process.env.CLEANUP_RECEIPT,JSON.stringify({called:true,report:file!==null,
          sha256:file?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null}));\n`, { mode: 0o755 })
      const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', step.script], {
        cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...identity, RUNNER_TEMP: directory,
          CLEANUP_RECEIPT: receipt, ARTIFACT_OUTCOME: scenario.outcome, CANDIDATE_ARTIFACT_ID: scenario.id,
          RUNTIME_REPORT_SHA256: scenario.name === 'digest-mismatch' ? 'f'.repeat(64) : hash(bytes), RUNTIME_WORKER_SHA: WORKER },
      })
      assert.equal(result.error?.code, undefined, scenario.name)
      assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stderr}`)
      assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), {
        called: true, report: scenario.useReport, sha256: scenario.useReport ? hash(bytes) : null,
      })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})
