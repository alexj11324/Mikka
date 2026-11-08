import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertWorkspaceAttestation, codingWorkspaceChanged, workspaceReleaseSelection } from './coding-workspace-ci.mjs'

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40)
const REPOSITORY = 'alexj11324/Mikka'
const workflow = { id: 405833668, name: 'E2B additive runtime release', path: '.github/workflows/e2b-official-runtime.yml', state: 'active' }
const run = { id: 123, run_attempt: 2, workflow_id: workflow.id, name: workflow.name, path: workflow.path,
  head_sha: SHA, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } }

function preCheckoutScript() {
  const lines = readFileSync(new URL('../../.github/workflows/coding-workspace-acceptance.yml', import.meta.url), 'utf8').split('\n')
  const from = lines.findIndex(line => line.trim() === "node --input-type=module <<'JS'")
  const to = lines.findIndex((line, index) => index > from && line.trim() === 'JS')
  assert.ok(from >= 0 && to > from)
  const indent = lines[from].match(/^ */)[0].length
  return lines.slice(from + 1, to).map(line => line.slice(indent)).join('\n')
}
function authenticate(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-workspace-ci-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = { event: { workflow_run: structuredClone(run) }, workflow: structuredClone(workflow), run: structuredClone(run),
    main: { object: { type: 'commit', sha: SHA } }, status: 200,
    env: { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_TOKEN: 'private-token-sentinel' } }
  mutate(fixture)
  const fixturePath = join(root, 'fixture.json'), eventPath = join(root, 'event.json'), output = join(root, 'output')
  writeFileSync(fixturePath, JSON.stringify(fixture)); writeFileSync(eventPath, JSON.stringify(fixture.event)); writeFileSync(output, '')
  const setup = `
    import { readFileSync as readFixture } from 'node:fs'
    const fixture = JSON.parse(readFixture(process.env.FIXTURE_PATH, 'utf8'))
    globalThis.fetch = async (url, options) => {
      if (!url.startsWith('https://api.github.com/repos/alexj11324/Mikka/') || options.redirect !== 'error'
        || options.headers.authorization !== 'Bearer private-token-sentinel') throw Error('unexpected_request')
      const routes = { '/actions/workflows/e2b-official-runtime.yml': fixture.workflow,
        ['/actions/runs/' + fixture.event.workflow_run.id]: fixture.run, '/git/ref/heads/main': fixture.main }
      const route = url.slice('https://api.github.com/repos/alexj11324/Mikka'.length)
      if (!Object.hasOwn(routes, route)) throw Error('unexpected_request')
      return Response.json(routes[route], { status: fixture.status })
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: setup + preCheckoutScript(), encoding: 'utf8',
    env: { PATH: process.env.PATH, ...fixture.env, FIXTURE_PATH: fixturePath, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output } })
  return { ...result, output: readFileSync(output, 'utf8') }
}

test('actual pre-checkout workflow script accepts only the confirmed main release attempt', t => {
  const result = authenticate(t)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, `source-sha=${SHA}\nupstream-run-id=123\nupstream-run-attempt=2\n`)
})
for (const [name, mutate] of Object.entries({
  'fork receiver': value => { value.env.GITHUB_REPOSITORY = 'fork/Mikka' },
  'non-main receiver': value => { value.env.GITHUB_REF = 'refs/pull/123/merge' },
  'PR pointer': value => { value.event.workflow_run.event = 'pull_request' },
  'fork source': value => { value.event.workflow_run.head_repository.full_name = 'fork/Mikka' },
  'invalid ref injection': value => { value.event.workflow_run.head_sha = 'main\nPRIVATE' },
  'failed upstream': value => { value.run.conclusion = 'failure' },
  'different attempt': value => { value.run.run_attempt++ },
  'different workflow': value => { value.workflow.path = '.github/workflows/other.yml' },
  'advanced main': value => { value.main.object.sha = OTHER },
  'GitHub refusal': value => { value.status = 403 },
})) test('pre-checkout rejects ' + name + ' before any source or workload credentials', t => {
  const result = authenticate(t, mutate)
  assert.equal(result.status, 1)
  assert.equal(result.output, '')
  assert.equal(result.stderr.trim(), 'coding_workspace_source_refused')
  assert.ok(!result.stdout.includes('private-token-sentinel') && !result.stderr.includes('private-token-sentinel'))
})

test('only relevant changes with an actual validated publication select paid acceptance', () => {
  const files = ['lib/coding-workspace/identity.ts']
  assert.equal(codingWorkspaceChanged(files), true)
  assert.equal(codingWorkspaceChanged(['app/api/runs/[runId]/workspace/identity/route.ts']), true)
  assert.equal(codingWorkspaceChanged(['packages/daemon/src/coding-workspace/files.ts']), true)
  assert.equal(codingWorkspaceChanged(['packages/protocol/src/coding-workspace.ts']), true)
  assert.equal(codingWorkspaceChanged(['scripts/acceptance/coding-workspace.mjs']), true)
  assert.equal(workspaceReleaseSelection({ runtime: 'validated_and_published' }, files).selected, true)
  assert.equal(workspaceReleaseSelection({ runtime: 'unchanged_worker' }, files).selected, false)
  assert.equal(workspaceReleaseSelection({ runtime: 'validated_and_published' }, ['messages/en.json']).selected, false)
})

const expected = { sourceCommit: SHA, runId: 123, runAttempt: 2, workflowId: workflow.id }
function attestation() {
  return { kind: 'coding-workspace-ci-attestation', selected: true, runtime: 'validated_and_published', sourceCommit: SHA,
    workerSourceCommit: SHA, workerSha: OTHER, upstream: { runId: 123, runAttempt: 2, workflowId: workflow.id },
    web: { sourceCommit: SHA, publicBuild: SHA, webRunId: 456, webAttempt: 1 } }
}
test('attestation binds upstream attempt, actual Web and both source identities', () => {
  assert.doesNotThrow(() => assertWorkspaceAttestation(expected, attestation()))
  for (const mutate of [
    value => { value.kind = 'thread-lifecycle-ci-attestation' },
    value => { value.selected = false },
    value => { value.runtime = 'unchanged_worker' },
    value => { value.sourceCommit = OTHER },
    value => { value.workerSourceCommit = OTHER },
    value => { value.workerSha = 'main' },
    value => { value.upstream.runAttempt++ },
    value => { value.web.publicBuild = OTHER },
    value => { value.web.webAttempt = 0 },
  ]) {
    const changed = attestation(); mutate(changed)
    assert.throws(() => assertWorkspaceAttestation(expected, changed), /coding_workspace_ci:attestation/)
  }
})
