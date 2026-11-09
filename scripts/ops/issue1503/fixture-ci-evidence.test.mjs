import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as ci from './fixture-ci-evidence.mjs'

const files = {".github/workflows/factory-fixtures.yml": "name: Factory fixture checks\n\non:\n  pull_request:\n  push:\n    branches: [main]\n\npermissions:\n  contents: read\n\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n      - name: Confirm candidate checkout\n        env:\n          EXPECTED_COMMIT: ${{ github.event.pull_request.head.sha || github.sha }}\n        run: test \"$(git rev-parse HEAD)\" = \"$EXPECTED_COMMIT\"\n      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n        with:\n          node-version: 24\n      - name: Check the fixture validator\n        run: node --test scripts/validate-factory-files.test.mjs\n      - name: Verify committed Factory files\n        run: node scripts/validate-factory-files.mjs\n", "scripts/validate-factory-files.mjs": "import { readdir, readFile } from 'node:fs/promises'\nimport { basename, resolve } from 'node:path'\nimport { pathToFileURL } from 'node:url'\n\nexport function validateFixture(name, bytes) {\n  if (!/^\\d+-\\d+-(?:claude_code|codex)\\.txt$/.test(name)) {\n    throw new Error('Unexpected Factory fixture filename')\n  }\n  const marker = basename(name, '.txt')\n  const prefix = `Factory delivery acceptance #1503\\nCase: ${marker}\\nState: `\n  if (!['initial', 'revised'].some(state => bytes.equals(Buffer.from(`${prefix}${state}\\n`, 'utf8')))) {\n    throw new Error('Factory fixture bytes do not match its case and allowed state')\n  }\n}\n\nexport async function validateDirectory(directory = 'docs/issue-1503') {\n  let entries\n  try {\n    entries = await readdir(directory, { withFileTypes: true })\n  } catch (error) {\n    if (error.code === 'ENOENT') return 0\n    throw error\n  }\n  for (const entry of entries) {\n    if (!entry.isFile()) throw new Error('Factory fixtures must be regular files')\n    validateFixture(entry.name, await readFile(resolve(directory, entry.name)))\n  }\n  return entries.length\n}\n\nif (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {\n  const count = await validateDirectory()\n  console.log(`Verified ${count} committed Factory fixture file(s)`)\n}\n", "scripts/validate-factory-files.test.mjs": "import assert from 'node:assert/strict'\nimport { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport test from 'node:test'\nimport { validateDirectory, validateFixture } from './validate-factory-files.mjs'\n\nconst name = '42381382020-1-claude_code.txt'\nconst initial = Buffer.from('Factory delivery acceptance #1503\\nCase: 42381382020-1-claude_code\\nState: initial\\n')\n\ntest('both official subscription cases accept initial and requested revision bytes', () => {\n  for (const harness of ['claude_code', 'codex']) {\n    for (const state of ['initial', 'revised']) {\n      validateFixture(`42381382020-1-${harness}.txt`, Buffer.from(`Factory delivery acceptance #1503\\nCase: 42381382020-1-${harness}\\nState: ${state}\\n`))\n    }\n  }\n})\n\ntest('wrong case, altered header, missing newline and extra content fail CI', () => {\n  for (const contents of [\n    initial.toString().replace('42381382020-1-claude_code', '42381382020-1-codex'),\n    initial.toString().replace('#1503', '#1504'),\n    initial.toString().trimEnd(),\n    `${initial.toString()}extra\\n`,\n    initial.toString().replace('State: initial', 'State: approved'),\n  ]) assert.throws(() => validateFixture(name, Buffer.from(contents)))\n  assert.throws(() => validateFixture(name, Buffer.concat([initial, Buffer.from([0xff])])))\n  assert.throws(() => validateFixture('unrelated.txt', initial))\n})\n\ntest('checks actual repository bytes and rejects a changed file', async () => {\n  const root = await mkdtemp(join(tmpdir(), 'mikka-factory-ci-'))\n  try {\n    assert.equal(await validateDirectory(join(root, 'not-created')), 0)\n    await writeFile(join(root, name), initial)\n    assert.equal(await validateDirectory(root), 1)\n    await writeFile(join(root, name), initial.toString().replace('State: initial', 'State: invalid'))\n    await assert.rejects(validateDirectory(root))\n  } finally { await rm(root, { recursive: true, force: true }) }\n})\n\ntest('directories and symlinks cannot stand in for committed fixture files', async () => {\n  const root = await mkdtemp(join(tmpdir(), 'mikka-factory-ci-'))\n  try {\n    await mkdir(join(root, 'nested'))\n    await assert.rejects(validateDirectory(root))\n    await rm(join(root, 'nested'), { recursive: true })\n    await symlink('/dev/null', join(root, name))\n    await assert.rejects(validateDirectory(root))\n  } finally { await rm(root, { recursive: true, force: true }) }\n})\n"}
const head = '2'.repeat(40), base = '3'.repeat(40), branch = 'mikka/f1503-offline'
const repository = 'alexj11324/Mikka-handoff'
const runId = 101, jobId = 102, checkId = 103, suiteId = 104, prNumber = 105
const started = '2026-11-08T12:00:00.000Z', completed = '2026-11-08T12:01:00.000Z'
function sourceResponse(file) {
  const content = Buffer.from(files[file.path])
  return { type: 'file', path: file.path, sha: file.gitBlob, size: content.length,
    encoding: 'base64', content: content.toString('base64') }
}
function fixtures() {
  const repo = { full_name: repository }
  return {
    pr: { number: prNumber, state: 'open', draft: false, user: { login: 'alexj11324' },
      head: { sha: head, ref: branch, repo }, base: { sha: base, ref: 'main', repo } },
    checks: { total_count: 2, check_runs: [
      { id: checkId, name: 'verify', head_sha: head, status: 'completed', conclusion: 'success',
        app: { slug: 'github-actions' }, check_suite: { id: suiteId },
        details_url: 'https://github.com/' + repository + '/actions/runs/' + runId + '/job/' + jobId },
      { id: 106, name: 'GitGuardian Security Checks', head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'gitguardian' } },
    ] },
    statuses: { sha: head, state: 'pending', total_count: 0, statuses: [] },
    run: { id: runId, run_attempt: 1, name: 'Factory fixture checks', path: ci.FIXTURE_CI_CONTRACT.workflowPath,
      event: 'pull_request', head_sha: head, head_branch: branch, check_suite_id: suiteId,
      status: 'completed', conclusion: 'success', repository: repo, head_repository: repo,
      pull_requests: [{ number: prNumber, head: { sha: head }, base: { sha: base } }] },
    job: { id: jobId, run_id: runId, run_attempt: 1, name: 'verify', head_sha: head, head_branch: branch,
      status: 'completed', conclusion: 'success', started_at: started, completed_at: completed,
      check_run_url: 'https://api.github.com/repos/' + repository + '/check-runs/' + checkId,
      steps: ci.FIXTURE_CI_CONTRACT.requiredSteps.map((step, index) => ({ name: step.name, number: index + 2,
        status: 'completed', conclusion: 'success', started_at: started, completed_at: completed })) },
    sources: Object.fromEntries(ci.FIXTURE_CI_CONTRACT.files.map(file => [file.path, sourceResponse(file)])),
  }
}
function reader(data, calls = []) {
  return async path => {
    calls.push(path)
    if (path === '/pulls/' + prNumber) return structuredClone(data.pr)
    if (path === '/commits/' + head + '/check-runs?filter=latest&per_page=100') return structuredClone(data.checks)
    if (path === '/commits/' + head + '/status?per_page=100') return structuredClone(data.statuses)
    if (path === '/actions/runs/' + runId) return structuredClone(data.run)
    if (path === '/actions/jobs/' + jobId) return structuredClone(data.job)
    for (const file of ci.FIXTURE_CI_CONTRACT.files) {
      if (path === '/contents/' + file.path + '?ref=' + head || path === '/contents/' + file.path + '?ref=' + base)
        return structuredClone(data.sources[file.path])
    }
    assert.fail('Unexpected read path')
  }
}
const binding = { candidateSha: head, pullRequestUrl: 'https://github.com/' + repository + '/pull/' + prNumber, expectedBranch: branch }
const evidence = data => ci.collectFixtureCiEvidence(reader(data), binding)
function actualShapeCriteria() {
  return [
    { text: 'Exact UTF-8 contents and final newline', passed: true, status: 'passed', evidence: 'Independent inspect_artifact receipt.' },
    { text: 'Repository validator accepts the committed fixture.', passed: false, status: 'unverified', reason: 'This read-only reviewer cannot execute the validator.' },
    { text: 'Validator unit tests pass.', passed: false, status: 'unverified', reason: 'This read-only reviewer cannot execute the tests.' },
    { text: 'Only that file is added and no other file is edited', passed: true, status: 'passed', evidence: 'Independent inspect_repository receipt with exact baseline and fixed head.' },
    { text: "The 'verify' job of the Factory fixture checks and every other check on the pushed commit complete successfully.", passed: false, status: 'unverified', reason: 'This reviewer cannot query GitHub.' },
  ]
}

/** Evaluate the actual complete driver module with all unrelated API/provider
 * dependencies forbidden. No source function is copied or reimplemented. */
async function deliveryModule() {
  const selected = process.env.ISSUE1503_OFFLINE_DELIVERY_SOURCE
    ?? fileURLToPath(new URL('./delivery.mjs', import.meta.url))
  const source = await readFile(selected, 'utf8')
  const forbidden = () => assert.fail('Offline criterion test called a business or provider dependency')
  const context = vm.createContext({ Buffer, URL, console, setTimeout, clearTimeout,
    process: { argv: [], env: {} }, fetch: forbidden })
  const module = new vm.SourceTextModule(source, { context, identifier: selected,
    initializeImportMeta(meta) { meta.url = pathToFileURL(selected).href } })
  const stubs = {
    './http.ts': { smokeSession: forbidden, fail: code => { throw new Error('issue1503_' + code) }, SMOKE_ID: 'smoke', OWNER_ID: 'owner' },
    '../../../lib/desktop-rpc/wire.ts': { encode: forbidden, decode: forbidden },
    '../../../lib/action-result.ts': { ACTION_ERROR_CODES: [] },
    './explicit-submission.mjs': Object.fromEntries(['explicitNewTaskArguments', 'explicitNewTaskComplete', 'explicitNewTaskEvidence', 'explicitNewTaskCleanupReceipts'].map(key => [key, forbidden])),
    './question-confirmation.mjs': Object.fromEntries(['codexQuestionConfirmation', 'confirmationQuestionReference', 'confirmationRunEvidence', 'confirmationAnswerReceipt'].map(key => [key, forbidden])),
    './own-vm-diagnostic.mjs': { createOwnVmDiagnostic: forbidden },
    './fixture-ci-evidence.mjs': ci,
  }
  await module.link(async specifier => {
    const values = specifier.startsWith('node:') ? await import(specifier) : stubs[specifier]
    assert.ok(values, 'Unexpected driver dependency: ' + specifier)
    const keys = Object.keys(values)
    return new vm.SyntheticModule(keys, function () { for (const key of keys) this.setExport(key, values[key]) }, { context })
  })
  await module.evaluate()
  return module.namespace
}
const driver = await deliveryModule()
function taskState(criteria = actualShapeCriteria()) {
  const run = '10000000-0000-4000-8000-000000000001'
  const attempt = { id: '10000000-0000-4000-8000-000000000002', stage: 'review', status: 'passed',
    candidateId: '10000000-0000-4000-8000-000000000003', runId: run }
  const check = { attemptId: attempt.id, stage: 'review', status: 'passed', candidateId: attempt.candidateId,
    candidateSha: head, runId: run, criteria, verify: { status: 'passed', command: 'node check.js', exitCode: 0 } }
  return { state: { task: { route: { flowVersion: 2 } }, candidates: [{ id: attempt.candidateId, sha: head }], checks: [check] }, attempt }
}

test('actual read-only reviewer shape: independent exact-head CI covers only its three unavailable observations', async () => {
  const receipt = await evidence(fixtures())
  const { state, attempt } = taskState(), original = structuredClone(state.checks[0].criteria)
  assert.equal(driver.matchedCheckEvidence(state, [attempt], receipt).length, 1)
  assert.deepEqual(state.checks[0].criteria, original, 'unverified and reason must never be rewritten into a reviewer pass')
  assert.deepEqual(ci.reviewCriteriaEvidence(original, head, receipt).covered.map(item => item.criterion),
    ['repository_validator', 'validator_tests', 'exact_head_checks'])
})
test('valid receipt pins actual checkout confirmation, exact commands and both source trees with eleven bounded reads', async () => {
  const calls = [], receipt = await ci.collectFixtureCiEvidence(reader(fixtures(), calls), binding)
  assert.equal(calls.length, 11)
  assert.equal(new Set(calls).size, 11)
  assert.equal(receipt.job.steps.find(step => step.purpose === 'exact_head').conclusion, 'success')
  assert.equal(receipt.sources.length, 6)
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.job.steps))
  assert.ok(Object.isFrozen(ci.FIXTURE_CI_CONTRACT.files[0]) && Object.isFrozen(ci.FIXTURE_CI_CONTRACT.requiredSteps[0]))
  assert.deepEqual(receipt.checks.checkRuns.map(item => [item.id, item.headSha, item.status, item.conclusion]),
    [[checkId, head, 'completed', 'success'], [106, head, 'completed', 'success']])
})
test('old scope regression still fails even with independently successful CI', async () => {
  const receipt = await evidence(fixtures()), { state, attempt } = taskState()
  state.checks[0].criteria[3] = { text: state.checks[0].criteria[3].text, passed: false, status: 'unverified', reason: 'Scope was not observed.' }
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], receipt), /issue1503_verification_criteria_missing/)
})
test('missing proof, serialized proof, and a proof for another candidate cannot cover unverified criteria', async () => {
  const receipt = await evidence(fixtures()), criteria = actualShapeCriteria()
  for (const proof of [null, {}, JSON.parse(JSON.stringify(receipt))])
    assert.equal(ci.reviewCriteriaEvidence(criteria, head, proof), null)
  assert.equal(ci.reviewCriteriaEvidence(criteria, '4'.repeat(40), receipt), null)
})
for (const [name, mutate] of [
  ['unknown unverified requirement', c => c.push({ text: 'A different deployment requirement', passed: false, status: 'unverified', reason: 'Unavailable' })],
  ['fuzzy label', c => { c[1].text += ' (including another validator)' }],
  ['JSON array exact-label coercion', c => { c[1].text = JSON.parse('["Repository validator accepts the committed fixture."]') }],
  ['explicit failed criterion', c => { c[1].status = 'failed'; c[1].evidence = 'Observed failure' }],
  ['missing reason', c => { delete c[1].reason }],
  ['duplicate external label', c => c.push({ ...c[1] })],
  ['unobserved exact contents', c => { c[0].passed = false; c[0].status = 'unverified'; c[0].reason = 'Missing artifact' }],
]) test(name + ' cannot be waived', async () => {
  const receipt = await evidence(fixtures()), { state, attempt } = taskState()
  mutate(state.checks[0].criteria)
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], receipt), /issue1503_verification_criteria_missing/)
})
test('CI does not waive check bindings or legacy verify requirements', async () => {
  const receipt = await evidence(fixtures()), { state, attempt } = taskState()
  state.checks[0].candidateSha = '4'.repeat(40)
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], receipt), /issue1503_verification_check_binding_mismatch/)
  state.checks[0].candidateSha = head
  state.task.route.flowVersion = 1
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], receipt), /issue1503_verification_criteria_missing/)
})

for (const [name, mutate] of [
  ['stale check head', d => { d.checks.check_runs[0].head_sha = base }],
  ['skipped check', d => { d.checks.check_runs[1].conclusion = 'skipped' }],
  ['pending external check', d => { d.checks.check_runs[1].status = 'in_progress'; d.checks.check_runs[1].conclusion = null }],
  ['truncated check page', d => { d.checks.total_count = 101 }],
  ['failed legacy status', d => { d.statuses = { sha: head, state: 'failure', total_count: 1, statuses: [{ state: 'failure' }] } }],
  ['missing verify check', d => { d.checks.check_runs[0].name = 'Some other job' }],
  ['foreign check URL', d => { d.checks.check_runs[0].details_url = 'https://example.invalid/actions/runs/101/job/102' }],
  ['old run head', d => { d.run.head_sha = base }],
  ['wrong PR base in run', d => { d.run.pull_requests[0].base.sha = '4'.repeat(40) }],
  ['different workflow', d => { d.run.path = '.github/workflows/other.yml' }],
  ['stale job attempt', d => { d.job.run_attempt = 2 }],
  ['old checkout job head', d => { d.job.head_sha = base }],
  ['unrelated job check-run', d => { d.job.check_run_url += '9' }],
  ['skipped SHA confirmation', d => { d.job.steps[1].conclusion = 'skipped' }],
  ['failed validator with green job', d => { d.job.steps[4].conclusion = 'failure' }],
  ['skipped unit tests with green job', d => { d.job.steps[3].conclusion = 'skipped' }],
  ['missing SHA confirmation', d => { d.job.steps.splice(1, 1) }],
  ['duplicate validator step', d => { d.job.steps.push({ ...d.job.steps[4] }) }],
  ['step outside job interval', d => { d.job.steps[3].completed_at = '2026-11-08T12:05:00Z' }],
  ['step execution order reversed', d => { d.job.steps[3].number = 1 }],
  ['old or modified workflow', d => { d.sources[ci.FIXTURE_CI_CONTRACT.workflowPath].content = Buffer.from(files[ci.FIXTURE_CI_CONTRACT.workflowPath].replace('          ref:', '          #ref:')).toString('base64') }],
  ['continue-on-error injected', d => { d.sources[ci.FIXTURE_CI_CONTRACT.workflowPath].content = Buffer.from(files[ci.FIXTURE_CI_CONTRACT.workflowPath] + '\n    continue-on-error: true\n').toString('base64') }],
  ['modified validator source', d => { d.sources['scripts/validate-factory-files.mjs'].sha = '4'.repeat(40) }],
  ['wrong PR author', d => { d.pr.user.login = 'someone-else' }],
]) test(name + ' fails closed', async () => {
  const data = fixtures(); mutate(data)
  await assert.rejects(evidence(data), /^Error: issue1503_ci_/)
})

test('read token is required; authorization failures expose no response or token', async () => {
  assert.throws(() => ci.createFixtureGithubReader(''), /issue1503_ci_read_token_required/)
  for (const status of [401, 403, 500]) {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    const read = ci.createFixtureGithubReader('offline-sensitive-token', async () => new Response(body, { status }))
    await assert.rejects(read('/pulls/' + prNumber), status === 500 ? /^Error: issue1503_ci_read_failed$/ : /^Error: issue1503_ci_read_unauthorized$/)
    assert.equal(cancelled, true, 'non-success HTTP bodies must be released before reporting failure')
  }
})
test('reader cannot change host, repo, method or follow redirects', async () => {
  let calls = 0
  const read = ci.createFixtureGithubReader('offline-sensitive-token', async (url, options) => {
    calls++
    assert.equal(url, 'https://api.github.com/repos/' + repository + '/pulls/' + prNumber)
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error')
    return new Response('{"ok":true}', { status: 200 })
  })
  for (const path of ['https://example.invalid/', '/../../other', '/pulls/105/comments', '/contents/private.txt?ref=' + head])
    await assert.rejects(read(path), /issue1503_ci_read_path_invalid/)
  assert.deepEqual(await read('/pulls/' + prNumber), { ok: true })
  assert.equal(calls, 1)
})
test('oversized GitHub responses are refused without returning body data', async () => {
  const read = ci.createFixtureGithubReader('offline-sensitive-token', async () => new Response('x'.repeat(1_048_577), { status: 200 }))
  await assert.rejects(read('/pulls/' + prNumber), /^Error: issue1503_ci_response_too_large$/)
})

test('caught transport, decode, JSON and URL failures retain private causes behind fixed public messages', async () => {
  const unchangedMessage = (message, cause, causeType = Error) => error => {
    assert.equal(error.message, message)
    if (cause) assert.equal(error.cause, cause)
    else assert.ok(error.cause instanceof causeType)
    assert.equal(error.toString(), 'Error: ' + message)
    assert.ok(!Object.keys(error).includes('cause'), 'native Error cause must not become an enumerable report field')
    return true
  }
  const fetchCause = new Error('offline private transport detail')
  await assert.rejects(ci.createFixtureGithubReader('offline-sensitive-token', async () => { throw fetchCause })('/pulls/' + prNumber),
    unchangedMessage('issue1503_ci_read_unavailable', fetchCause))

  const bodyCause = new Error('offline private body detail')
  const unreadable = { status: 200, ok: true, body: { getReader() { return { async read() { throw bodyCause } } } } }
  await assert.rejects(ci.createFixtureGithubReader('offline-sensitive-token', async () => unreadable)('/pulls/' + prNumber),
    unchangedMessage('issue1503_ci_read_unavailable', bodyCause))

  await assert.rejects(ci.createFixtureGithubReader('offline-sensitive-token',
    async () => new Response(new Uint8Array([255]), { status: 200 }))('/pulls/' + prNumber),
    unchangedMessage('issue1503_ci_read_unavailable', null, TypeError))
  await assert.rejects(ci.createFixtureGithubReader('offline-sensitive-token',
    async () => new Response('{"offline-private-detail":', { status: 200 }))('/pulls/' + prNumber),
    unchangedMessage('issue1503_ci_response_invalid', null, SyntaxError))

  const data = fixtures()
  data.checks.check_runs[0].details_url = 'offline-private-invalid-url'
  await assert.rejects(evidence(data), unchangedMessage('issue1503_ci_check_job_binding', null, TypeError))
  const calls = []
  await assert.rejects(ci.collectFixtureCiEvidence(reader(fixtures(), calls),
    { ...binding, pullRequestUrl: 'offline-private-invalid-url' }),
    unchangedMessage('issue1503_ci_pr_binding', null, TypeError))
  assert.equal(calls.length, 0)

  const cancellationCause = new Error('offline private cancellation detail')
  const unauthorized = { status: 403, ok: false, body: { async cancel() { throw cancellationCause } } }
  await assert.rejects(ci.createFixtureGithubReader('offline-sensitive-token', async () => unauthorized)('/pulls/' + prNumber),
    unchangedMessage('issue1503_ci_read_unauthorized', cancellationCause))
})

const implementationLabel = 'Run a small command that reads the file and verifies these requirements.'
function implementationFixture(candidateSha = head, expectedState = 'initial') {
  const expectedText = 'Factory delivery acceptance #1503\nCase: offline\nState: ' + expectedState + '\n'
  const filePath = 'docs/issue-1503/offline.txt', command = 'node exact-fixture-check'
  const selected = { taskId: '20000000-0000-4000-8000-000000000001',
    producerRunId: '20000000-0000-4000-8000-000000000002', candidateSha, expectedBranch: branch,
    command, filePath, expectedText, expectedState }
  const artifact = { raw: { publish: { pushed: true, branch, commit: candidateSha, remote: 'origin' },
    verify: { status: 'passed', command, exitCode: 0, timedOut: false, signal: null,
      output: JSON.stringify({ issue: 1503, files: [{ path: filePath, state: expectedState,
        bytes: Buffer.byteLength(expectedText), sha256: createHash('sha256').update(expectedText).digest('hex') }] }) } } }
  return { selected, artifact }
}
async function implementationEvidence(input = implementationFixture(), calls = []) {
  return ci.collectFixtureImplementationEvidence(async path => {
    calls.push(path)
    assert.equal(path, '/api/factory/tasks/' + input.selected.taskId + '/approval?artifact='
      + encodeURIComponent('run-report:' + input.selected.producerRunId))
    return structuredClone(input.artifact)
  }, input.selected)
}
function commandCriteria() {
  const criteria = actualShapeCriteria()
  criteria.splice(3, 0, { text: implementationLabel, passed: false, status: 'unverified',
    reason: 'The read-only reviewer inspected the file but cannot run the producer command.' })
  return criteria
}
function commandTask(criteria = commandCriteria()) {
  const value = taskState(criteria), selected = implementationFixture().selected
  value.state.task.id = selected.taskId
  value.state.candidates[0].runId = selected.producerRunId
  return value
}
test('implementation command: F186 fixed label requires a fresh bound daemon observation and preserves review facts', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  const { state, attempt } = commandTask(), before = structuredClone(state.checks[0].criteria)
  assert.equal(driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt).length, 1)
  assert.deepEqual(state.checks[0].criteria, before)
  const covered = ci.reviewCriteriaEvidence(before, head, external, {
    requireExplicitStatus: true, implementationReceipt: implementation.receipt }).covered
  assert.deepEqual(covered.map(item => item.criterion),
    ['repository_validator', 'validator_tests', 'implementation_file_command', 'exact_head_checks'])
  const command = covered.find(item => item.criterion === 'implementation_file_command')
  assert.equal(command.producerRunId, implementationFixture().selected.producerRunId)
  assert.equal(command.candidateSha, head)
  assert.equal(command.fileSha256, implementation.verifiedContent.sha256)
  assert.equal(command.commandSha256, implementation.verifiedContent.commandSha256)
})
test('implementation command: the collector makes one exact artifact read and emits frozen metadata', async () => {
  const calls = [], result = await implementationEvidence(implementationFixture(), calls)
  assert.equal(calls.length, 1)
  assert.ok(Object.isFrozen(result.receipt))
  assert.equal(result.receipt.taskId, implementationFixture().selected.taskId)
  assert.equal(result.receipt.producerRunId, implementationFixture().selected.producerRunId)
  assert.equal(result.receipt.command, undefined)
  assert.equal(result.receipt.output, undefined)
  assert.equal(result.receipt.expectedText, undefined)
  assert.throws(() => { result.receipt.candidateSha = base }, TypeError)
})
test('implementation command: missing, copied, wrong-task, wrong-run and wrong-head evidence cannot authorize the criterion', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  for (const receipt of [null, {}, JSON.parse(JSON.stringify(implementation.receipt))]) {
    const { state, attempt } = commandTask()
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, receipt),
      /issue1503_verification_criteria_missing/)
  }
  for (const mutate of [
    s => { s.task.id = '20000000-0000-4000-8000-000000000009' },
    s => { s.candidates[0].runId = '20000000-0000-4000-8000-000000000009' },
  ]) {
    const { state, attempt } = commandTask(); mutate(state)
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
      /issue1503_verification_criteria_missing/)
  }
  const otherHead = await implementationEvidence(implementationFixture(base))
  const current = commandTask()
  assert.throws(() => driver.matchedCheckEvidence(current.state, [current.attempt], external, otherHead.receipt),
    /issue1503_verification_criteria_missing/, 'matching task/run and valid current CI cannot authorize another implementation head')
  assert.equal(ci.reviewCriteriaEvidence(commandCriteria(), base, external,
    { implementationReceipt: implementation.receipt }), null)
})
test('implementation command: exact daemon success, publication and file bytes remain mandatory', async () => {
  const mutations = [
    x => { x.artifact.raw.publish.commit = base },
    x => { x.artifact.raw.publish.branch = 'mikka/other' },
    x => { x.artifact.raw.publish.pushed = false },
    x => { x.artifact.raw.publish.remote = 'other' },
    x => { x.artifact.raw.verify.command = 'node different-command' },
    x => { x.artifact.raw.verify.exitCode = 1 },
    x => { x.artifact.raw.verify.status = 'not_run' },
    x => { x.artifact.raw.verify.timedOut = true },
    x => { x.artifact.raw.verify.signal = 'SIGTERM' },
    x => { x.selected.expectedText += 'unexpected' },
    x => { x.selected.expectedState = 'revised' },
    x => { x.artifact.raw.verify.output = '{"issue":1503,"files":[]}' },
  ]
  for (const mutate of mutations) {
    const value = implementationFixture(); mutate(value)
    await assert.rejects(implementationEvidence(value), /^Error: issue1503_(?:publication_report_mismatch|implementation_command_verification_missing|implementation_file_bytes_mismatch)$/)
  }
  let reads = 0
  const invalid = implementationFixture().selected; invalid.producerRunId = '../other'
  await assert.rejects(ci.collectFixtureImplementationEvidence(async () => { reads++; return null }, invalid),
    /issue1503_ci_implementation_binding_invalid/)
  assert.equal(reads, 0)
})
test('implementation command: unknown, failed, duplicate and missing-reason requirements remain rejected', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  for (const mutate of [
    c => { c[3].text += ' and an unrelated deployment' },
    c => { c[3].text = [implementationLabel] },
    c => { c[3].status = 'failed' },
    c => { delete c[3].reason },
    c => { c[3].reason = ' '.repeat(10) },
    c => { c[3].reason = 'x'.repeat(2001) },
    c => { c.push({ ...c[3] }) },
    c => { c.push({ text: 'Only the requested file changed', passed: false, status: 'unverified', reason: 'Not observed' }) },
  ]) {
    const { state, attempt } = commandTask(); mutate(state.checks[0].criteria)
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
      /issue1503_verification_criteria_missing/)
  }
  const { state, attempt } = commandTask()
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], null, implementation.receipt),
    /issue1503_verification_criteria_missing/, 'daemon evidence cannot substitute for the three GitHub CI requirements')
  state.task.route.flowVersion = 1
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
    /issue1503_verification_criteria_missing/, 'legacy verification requirements stay unchanged')
})
test('implementation command: a historical review retains only its initial producer proof', async () => {
  const external = await evidence(fixtures()), initial = await implementationEvidence()
  const repairedInput = implementationFixture(base, 'revised')
  repairedInput.selected.producerRunId = '20000000-0000-4000-8000-000000000003'
  const repaired = await implementationEvidence(repairedInput)
  const { state, attempt } = commandTask()
  state.task.candidateId = '20000000-0000-4000-8000-000000000004'
  state.candidates.push({ id: state.task.candidateId, sha: base, runId: repairedInput.selected.producerRunId })
  assert.equal(driver.matchedCheckEvidence(state, [attempt], external, initial.receipt).length, 1)
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, repaired.receipt),
    /issue1503_verification_criteria_missing/)
})

/** F42606137512 observed the same fixture command label without its final period.
 * Accept only those two complete strings, with the existing daemon and CI proof. */
for (const [name, text] of [
  ['the canonical label with its final period', implementationLabel],
  ['the exact label without its final period', implementationLabel.slice(0, -1)],
]) test('terminal period: accepts ' + name, async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  const criteria = commandCriteria(); criteria[3].text = text
  const before = structuredClone(criteria), { state, attempt } = commandTask(criteria)
  assert.equal(driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt).length, 1)
  const covered = ci.reviewCriteriaEvidence(criteria, head, external,
    { implementationReceipt: implementation.receipt }).covered
  const command = covered.find(item => item.criterion === 'implementation_file_command')
  assert.ok(command)
  assert.equal(command.taskId, state.task.id)
  assert.equal(command.producerRunId, state.candidates[0].runId)
  assert.equal(command.candidateSha, head)
  assert.equal(command.fileSha256, implementation.verifiedContent.sha256)
  assert.equal(command.commandSha256, implementation.verifiedContent.commandSha256)
  assert.deepEqual(criteria, before)
  assert.equal(criteria[3].passed, false)
  assert.equal(criteria[3].status, 'unverified')
})

test('terminal period: rejects whitespace, other punctuation, narrative and non-string labels', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  const bare = implementationLabel.slice(0, -1)
  for (const text of [
    ' ' + bare, implementationLabel + ' ', bare + '\n',
    bare + '..', bare + '…', bare + '。', bare + '!',
    bare.replace('Run', 'run'), 'Observed: ' + bare,
    implementationLabel + ' The producer already did this.',
    bare + ' and an unrelated deployment', null, [bare],
  ]) {
    const { state, attempt } = commandTask(); state.checks[0].criteria[3].text = text
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
      /issue1503_verification_criteria_missing/)
  }
})

test('terminal period: both forms share one duplicate identity even when one is passed', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  const forms = [implementationLabel, implementationLabel.slice(0, -1)]
  for (const first of forms) for (const second of forms) for (const passed of [false, true]) {
    const { state, attempt } = commandTask(), criteria = state.checks[0].criteria
    criteria[3].text = first
    criteria.push({ ...criteria[3], text: second, passed,
      status: passed ? 'passed' : 'unverified', ...(passed ? { evidence: 'Independent observation.' } : {}) })
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
      /issue1503_verification_criteria_missing/)
  }
})

test('terminal period: the no-period label still refuses absent, fabricated and copied receipts', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  for (const receipt of [null, {}, { ...implementation.receipt }, JSON.parse(JSON.stringify(implementation.receipt))]) {
    const { state, attempt } = commandTask()
    state.checks[0].criteria[3].text = implementationLabel.slice(0, -1)
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, receipt),
      /issue1503_verification_criteria_missing/)
  }
})

test('terminal period: the no-period label remains bound to the same task, producer and exact head', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  for (const mutate of [
    state => { state.task.id = '20000000-0000-4000-8000-000000000009' },
    state => { state.candidates[0].runId = '20000000-0000-4000-8000-000000000009' },
  ]) {
    const { state, attempt } = commandTask(); state.checks[0].criteria[3].text = implementationLabel.slice(0, -1)
    mutate(state)
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
      /issue1503_verification_criteria_missing/)
  }
  const otherHead = await implementationEvidence(implementationFixture(base)), { state, attempt } = commandTask()
  state.checks[0].criteria[3].text = implementationLabel.slice(0, -1)
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, otherHead.receipt),
    /issue1503_verification_criteria_missing/)
})

test('terminal period: the no-period label preserves explicit unverified reason and failure guards', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  for (const mutate of [
    criterion => { criterion.status = 'failed' },
    criterion => { criterion.passed = true },
    criterion => { delete criterion.reason },
    criterion => { criterion.reason = '  ' },
    criterion => { criterion.reason = 'x'.repeat(2001) },
  ]) {
    const { state, attempt } = commandTask(), criterion = state.checks[0].criteria[3]
    criterion.text = implementationLabel.slice(0, -1); mutate(criterion)
    assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
      /issue1503_verification_criteria_missing/)
  }
})

test('terminal period: the no-period label cannot replace CI or change legacy review admission', async () => {
  const external = await evidence(fixtures()), implementation = await implementationEvidence()
  const { state, attempt } = commandTask(); state.checks[0].criteria[3].text = implementationLabel.slice(0, -1)
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], null, implementation.receipt),
    /issue1503_verification_criteria_missing/)
  state.task.route.flowVersion = 1
  assert.throws(() => driver.matchedCheckEvidence(state, [attempt], external, implementation.receipt),
    /issue1503_verification_criteria_missing/)
})
