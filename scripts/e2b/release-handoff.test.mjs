import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { handoffOutputs, packCandidates, packRelease, readHandoff } from './release-handoff.mjs'

const SOURCE = 'b'.repeat(40), WORKER = 'a'.repeat(40)
const KINDS = ['desktop', 'claude', 'codex']
const ENV = { PATH: process.env.PATH, GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: SOURCE, GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1' }
const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
function step(source, name) {
  const text = source.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0]
  assert.ok(text, `workflow step ${name}`)
  const block = text.split('        run: |\n')[1]?.split(/\n        [a-z-]+:/)[0]
  assert.ok(block, `workflow shell ${name}`)
  return { text, run: block.split('\n').map(line => line.replace(/^          /, '')).join('\n') }
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'e2b-release-handoff-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const report = { sourceCommit: SOURCE, workerSha: WORKER, templates: Object.fromEntries(KINDS.map(kind => [kind, {
    templateId: `tpl-${kind}`, buildId: `build-${kind}`, name: `mikka-${SOURCE.slice(0, 12)}-${ENV.GITHUB_RUN_ID}-1-${kind}`,
    baseTemplate: kind, preinstalled: true, models: [{ harness: kind === 'codex' ? 'codex' : 'claude_code', models: ['fixture'] }],
    conservation: { before: { entries: 1000, sha256: 'd'.repeat(64) }, after: { entries: 1000, sha256: 'd'.repeat(64) },
      finalization: { providerChanges: Array.from({ length: 700 }, (_, index) => ({ path: `/fixture/certificate-${index}`,
        before: { sha256: 'e'.repeat(64) }, after: { target: `/fixture/target-${index}` } })) } },
  }])) }
  const input = join(dir, 'candidates.json'), candidateDir = join(dir, 'candidate-handoff')
  const bytes = JSON.stringify(report, null, 2) + '\n'
  assert.ok(Buffer.byteLength(bytes) > 310_446, 'full conservation receipt exceeds the observed production failure')
  writeFileSync(input, bytes)
  const candidate = packCandidates(input, candidateDir, ENV)
  const env = { ...ENV, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'outputs'), RUNTIME_WORKER_SHA: WORKER,
    RUNTIME_REPORT_SHA256: candidate.manifest.reportSha256, RUNTIME_TEMPLATE_IDS: JSON.stringify(Object.fromEntries(KINDS.map(kind => [kind, `tpl-${kind}`]))) }
  const release = structuredClone(report)
  for (const row of Object.values(release.templates)) Object.assign(row, { public: true, buildStatus: 'ready' })
  release.subscriptionAcceptance = { claude: { status: 'passed', fixture: true }, codex: { status: 'passed', fixture: true } }
  return { dir, input, candidateDir, candidate, env, report, bytes, release }
}

test('the actual subscription shell starts with a receipt larger than Linux MAX_ARG_STRLEN', t => {
  const f = fixture(t), shell = step(workflow('e2b-official-runtime'), 'Require real Claude Code and Codex subscriptions on the private candidates')
  const scripts = join(f.dir, 'scripts/e2b'); mkdirSync(scripts, { recursive: true })
  copyFileSync(new URL('./release-handoff.mjs', import.meta.url), join(scripts, 'release-handoff.mjs'))
  // Only the model-calling validator is replaced: the real workflow shell and
  // real handoff verifier execute in a child process, with no SDK or network.
  writeFileSync(join(scripts, 'validate-template-subscriptions.mjs'), `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], readFileSync(process.argv[2]));`)
  const result = spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell.run], {
    cwd: f.dir, env: { ...f.env, ...(shell.text.includes('CANDIDATE_REPORT:') ? { CANDIDATE_REPORT: f.bytes } : {}) }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.error?.code, undefined, 'no complete report may be placed in the shell environment')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(f.dir, 'accepted.json'), 'utf8'), f.bytes, 'no conservation field is truncated or reserialized')
})

test('both artifact stages retain every byte and only emit bounded identity outputs', t => {
  const f = fixture(t)
  assert.equal(readFileSync(join(f.candidateDir, 'report.json'), 'utf8'), f.bytes)
  assert.deepEqual(readHandoff(f.candidateDir, 'candidates', f.env).report, f.report)
  const releaseFile = join(f.dir, 'release.json'), releaseDir = join(f.dir, 'release-handoff')
  const releaseBytes = JSON.stringify(f.release, null, 2) + '\n'; writeFileSync(releaseFile, releaseBytes)
  const packed = packRelease(releaseFile, releaseDir, f.candidateDir, { ...f.env, GITHUB_RUN_ATTEMPT: '2' })
  const loaded = readHandoff(releaseDir, 'release', { ...f.env, GITHUB_RUN_ATTEMPT: '3', RUNTIME_REPORT_SHA256: packed.manifest.reportSha256,
    RUNTIME_CANDIDATE_REPORT_SHA256: f.candidate.manifest.reportSha256 })
  assert.deepEqual(loaded.report, f.release)
  assert.equal(loaded.manifest.candidateAttempt, '1'); assert.equal(loaded.manifest.producerAttempt, '2')
  assert.equal(readFileSync(join(releaseDir, 'report.json'), 'utf8'), releaseBytes)
  for (const handoff of [f.candidate, packed]) {
    const output = handoffOutputs(handoff)
    assert.ok(Buffer.byteLength(output) < 1024)
    assert.doesNotMatch(output, /conservation|providerChanges|subscriptionAcceptance|fixture\/certificate/)
  }
})

test('same-run reruns accept an earlier producer but reject foreign source, run, worker, IDs and future attempts', t => {
  const f = fixture(t)
  assert.doesNotThrow(() => readHandoff(f.candidateDir, 'candidates', { ...f.env, GITHUB_RUN_ATTEMPT: '2' }))
  for (const change of [{ GITHUB_REPOSITORY: 'other/Mikka' }, { GITHUB_SHA: 'c'.repeat(40) }, { GITHUB_RUN_ID: '123457' },
    { RUNTIME_WORKER_SHA: 'c'.repeat(40) }, { RUNTIME_TEMPLATE_IDS: JSON.stringify({ desktop: 'foreign', claude: 'tpl-claude', codex: 'tpl-codex' }) }]) {
    assert.throws(() => readHandoff(f.candidateDir, 'candidates', { ...f.env, ...change }), /runtime_handoff_/)
  }
  const path = join(f.candidateDir, 'handoff.json'), manifest = JSON.parse(readFileSync(path))
  for (const change of [{ producerAttempt: '2' }, { candidateAttempt: '2' }, { templates: { ...manifest.templates, codex: { templateId: 'tpl-codex', buildId: 'foreign' } } }]) {
    writeFileSync(path, JSON.stringify({ ...manifest, ...change }))
    assert.throws(() => readHandoff(f.candidateDir, 'candidates', f.env), /runtime_handoff_/)
  }
})

test('receipt tampering and changed candidate models or conservation fail before release handoff', t => {
  const f = fixture(t), releaseFile = join(f.dir, 'release.json')
  for (const change of [row => { row.models.push({ harness: 'foreign' }) }, row => { row.conservation.finalization.providerChanges.pop() },
    row => { row.buildId = 'foreign' }, row => { row.name += '-foreign' }]) {
    const report = structuredClone(f.release); change(report.templates.codex); writeFileSync(releaseFile, JSON.stringify(report))
    assert.throws(() => packRelease(releaseFile, join(f.dir, 'release-handoff'), f.candidateDir, f.env), /runtime_handoff_/)
  }
  writeFileSync(join(f.candidateDir, 'report.json'), f.bytes + ' ')
  assert.throws(() => readHandoff(f.candidateDir, 'candidates', f.env), /runtime_handoff_digest_mismatch/)
  assert.equal(f.candidate.manifest.reportSha256, createHash('sha256').update(f.bytes).digest('hex'))
})

test('the actual cleanup shell always runs owned cleanup, rejects bad evidence and accepts an earlier attempt', t => {
  const shell = step(workflow('e2b-official-runtime'), "Close this attempt's instances and remove only its private candidates")
  assert.match(shell.text, /if: always\(\) && steps\.e2b-key\.outcome == 'success'/)
  for (const mode of ['valid', 'corrupted', 'missing', 'partial', 'upload-failed', 'cleanup-failed']) {
    const f = fixture(t), bin = join(f.dir, 'e2b-cleanup/bin'); mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'python'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; const args = process.argv.slice(2); writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(args)); process.exit(Number(process.env.CLEANUP_FIXTURE_EXIT ?? 0));\n`, { mode: 0o700 })
    if (mode === 'corrupted') writeFileSync(join(f.candidateDir, 'report.json'), '{"private_marker":true}')
    if (mode === 'missing' || mode === 'partial') rmSync(f.candidateDir, { recursive: true })
    const env = { ...f.env, GITHUB_RUN_ATTEMPT: '2', CANDIDATE_ARTIFACT_ID: ['partial', 'upload-failed'].includes(mode) ? '' : '12345',
      ...(mode === 'partial' ? { RUNTIME_REPORT_SHA256: '' } : {}), CLEANUP_FIXTURE_EXIT: mode === 'cleanup-failed' ? '7' : '0' }
    const result = spawnSync('/usr/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell.run], {
      cwd: new URL('../../', import.meta.url), env, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.error, undefined, mode)
    assert.equal(result.status, mode === 'cleanup-failed' ? 7 : ['valid', 'partial'].includes(mode) ? 0 : 1, mode)
    const args = JSON.parse(readFileSync(join(f.dir, 'release-cleanup.json')))
    assert.equal(args.includes('--report'), ['valid', 'cleanup-failed'].includes(mode), 'invalid evidence never supplies cleanup IDs')
    assert.equal(args[0], 'scripts/e2b/cleanup-template-candidates.py')
    assert.doesNotMatch(result.stdout + result.stderr, /private_marker|providerChanges|fixture\/certificate/)
  }
})

test('workflow boundaries carry fixed artifact IDs and hashes, never full reports', () => {
  const build = workflow('e2b-template'), runtime = workflow('e2b-official-runtime'), web = workflow('web-deploy')
  for (const source of [build, runtime, web]) assert.doesNotMatch(source, /(?:CANDIDATE_REPORT|RUNTIME_RELEASE_EVIDENCE|TEMPLATE_MODELS):|(?:candidate-report|release-evidence|runtime-release-evidence|runtime-template-models):/)
  assert.match(runtime, /node --test[^\n]+scripts\/e2b\/release-handoff\.test\.mjs/)
  assert.match(build, /name: e2b-candidates-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(runtime, /name: e2b-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  for (const source of [runtime, web]) for (const block of source.split('\n      - name: ').filter(value => value.includes('uses: actions/download-artifact@'))) {
    assert.match(block, /if: [^\n]+artifact-id != ''/, 'empty artifact IDs must not download all artifacts')
    assert.match(block, /artifact-ids: \$\{\{ (?:needs\.validate\.outputs\.candidate-artifact-id|inputs\.runtime-release-artifact-id) \}\}/)
    assert.match(block, /merge-multiple: true/)
    assert.doesNotMatch(block, /\n          (?:name|pattern|run-id|repository|github-token):/, 'downloads stay inside this workflow run')
  }
})
