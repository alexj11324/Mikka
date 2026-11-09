import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { attestCodingWorkspace, readWorkspaceReviewOptions } from './coding-workspace-ci.mjs'

const app = 'a'.repeat(40), source = 'b'.repeat(40), worker = 'c'.repeat(40), token = 'synthetic-private-github-token'
const repo = 'alexj11324/Mikka', api = `https://api.github.com/repos/${repo}`
const env = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: app, APPLICATION_SHA: app, EXPECTED_SOURCE_SHA: app, GITHUB_RUN_ID: '990', GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: token,
  EXPECTED_WORKER_SHA: worker, EXPECTED_WORKER_SOURCE_SHA: source, EXPECTED_CLAUDE_TEMPLATE: 'released-claude', EXPECTED_CODEX_TEMPLATE: 'released-codex',
  WORKSPACE_REVIEW_RELEASE_RUN_ID: '123', WORKSPACE_REVIEW_RELEASE_RUN_ATTEMPT: '2', ACCEPTANCE_MODE: 'workspace-review',
  TASK_SECRETS_MODEL_CASE: 'all', PRODUCTION_CANARY: 'false', FACTORY_ACCEPTANCE_REQUESTED: 'false', TASK_SECRETS_WINDOW: '' })

function fixture() {
  const now = Date.now(), workflow = { id: 456, name: 'E2B additive runtime release', path: '.github/workflows/e2b-official-runtime.yml', state: 'active' }
  const run = { id: 123, run_attempt: 2, workflow_id: 456, name: workflow.name, path: workflow.path, head_sha: source, head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'success', run_started_at: new Date(now - 60000).toISOString(),
    repository: { id: 789, full_name: repo }, head_repository: { id: 789, full_name: repo } }
  const names = ['test', 'check', 'validate / build', 'await-web', 'subscriptions', 'publish / deploy', 'cleanup']
  const jobs = { total_count: names.length, jobs: names.map((name, index) => ({ id: index + 1, name, run_id: 123, run_attempt: 2,
    head_sha: source, status: 'completed', conclusion: 'success' })) }
  const artifact = { id: 321, name: 'e2b-release-evidence-123-2', expired: false, size_in_bytes: 1000, digest: 'sha256:' + 'd'.repeat(64),
    created_at: new Date(now - 10000).toISOString(), expires_at: new Date(now + 3600000).toISOString(),
    url: `${api}/actions/artifacts/321`, archive_download_url: `${api}/actions/artifacts/321/zip`,
    workflow_run: { id: 123, repository_id: 789, head_repository_id: 789, head_branch: 'main', head_sha: source } }
  const report = { sourceCommit: source, workerSha: worker,
    templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, { name: `mikka-${source.slice(0, 12)}-123-2-${kind}`,
      baseTemplate: kind, templateId: `released-${kind}`, buildId: `build-${kind}`, preinstalled: true, public: true, buildStatus: 'ready' }])),
    subscriptionAcceptance: Object.fromEntries([['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']].map(([kind, harness, model]) => [kind, {
      status: 'passed', sourceCommit: source, workerSha: worker, templateId: `released-${kind}`, harness, model,
      credentialRoute: 'subscription', replyVerified: true, replyVerifiedAfterTool: true,
    }])) }
  const calls = []; let attestations = 0, reads = 0
  const data = { workflow, run, jobs, artifact, report, mutateFinalRun: false }
  return { data, calls, attestations: () => attestations, dependencies: { now: () => now,
    attest: async received => { assert.equal(received.APPLICATION_SHA, app); attestations++; return { sourceCommit: app, publicBuild: app } },
    fetchImpl: async (url, options) => {
      calls.push(url); assert.ok(url.startsWith(api + '/')); assert.equal(options.headers.authorization, 'Bearer ' + token)
      assert.equal(options.redirect, 'error')
      if (url === `${api}/actions/workflows/e2b-official-runtime.yml`) return Response.json(data.workflow)
      if (url === `${api}/actions/runs/123`) { reads++; return Response.json(data.mutateFinalRun && reads > 1 ? { ...data.run, run_attempt: 3 } : data.run) }
      if (url.endsWith('/attempts/2/jobs?per_page=100')) return Response.json(data.jobs)
      if (url.endsWith('/artifacts?per_page=100')) return Response.json({ total_count: 1, artifacts: [data.artifact] })
      if (url.endsWith('/actions/artifacts/321')) return Response.json(data.artifact)
      assert.fail('unexpected upstream read')
    },
    download: async (proof, options) => {
      assert.equal(proof.artifact.id, 321); assert.equal(proof.artifact.sha256, 'd'.repeat(64)); assert.equal(options.token, token)
      return Buffer.from(JSON.stringify(data.report))
    } } }
}

test('workspace-review is exclusive, explicit, main-bound and fixed to both original subscriptions', () => {
  const options = readWorkspaceReviewOptions(['--execute'], env())
  assert.equal(options.sourceCommit, app); assert.equal(options.workerSourceCommit, source)
  assert.equal(options.releaseRunId, 123); assert.equal(options.cleanupOnly, false)
  assert.equal(readWorkspaceReviewOptions(['--cleanup'], env()).cleanupOnly, true)
  for (const args of [[], ['--execute', '--cleanup'], ['--execute', '--production-canary'], ['--prepare']])
    assert.throws(() => readWorkspaceReviewOptions(args, env()), /workspace_review_guard_refused/)
  for (const change of [{ ACCEPTANCE_MODE: 'execute' }, { GITHUB_EVENT_NAME: 'workflow_run' }, { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_REPOSITORY: 'other/Mikka' }, { APPLICATION_SHA: source }, { PRODUCTION_CANARY: 'true' }, { FACTORY_ACCEPTANCE_REQUESTED: 'true' },
    { TASK_SECRETS_MODEL_CASE: 'claude' }, { TASK_SECRETS_WINDOW: 'existing-window' }, { WORKSPACE_REVIEW_RELEASE_RUN_ATTEMPT: '0' },
    { EXPECTED_WORKER_SHA: 'main' }, { EXPECTED_CODEX_TEMPLATE: 'released-claude' }])
    assert.throws(() => readWorkspaceReviewOptions(['--execute'], { ...env(), ...change }), /workspace_review_guard_refused/)
})

test('manual application and exact published worker release are independently bound before any workload credentials', async () => {
  const f = fixture(), environment = env()
  Object.defineProperties(environment, { SMOKE_OWNER_EMAIL: { get() { throw Error('credential read') } },
    SMOKE_OWNER_PASSWORD: { get() { throw Error('credential read') } }, E2B_API_KEY: { get() { throw Error('provider key read') } } })
  const proof = await attestCodingWorkspace(environment, f.dependencies)
  assert.equal(proof.sourceCommit, app); assert.equal(proof.workerSourceCommit, source); assert.equal(proof.workerSha, worker)
  assert.equal(proof.upstream.runAttempt, 2); assert.equal(proof.runtime, 'validated_and_published')
  assert.equal(f.attestations(), 2); assert.equal(JSON.stringify(proof).includes(token), false)
  assert.equal(f.calls.filter(url => url === `${api}/actions/runs/123`).length, 2)
})

test('a stale attempt, failed publish, wrong subscription/template or changed upstream is refused', async () => {
  for (const mutate of [
    data => { data.run.run_attempt = 1 }, data => { data.jobs.jobs.find(job => job.name === 'publish / deploy').conclusion = 'failure' },
    data => { data.jobs.jobs[2].conclusion = 'skipped' }, data => { data.artifact.workflow_run.head_sha = app },
    data => { data.report.templates.claude.templateId = 'other-template' },
    data => { data.report.subscriptionAcceptance.codex.model = 'gpt-6-pro' },
    data => { data.report.subscriptionAcceptance.claude.credentialRoute = 'api_key' }, data => { data.mutateFinalRun = true },
  ]) {
    const f = fixture(); mutate(f.data)
    await assert.rejects(attestCodingWorkspace(env(), f.dependencies))
  }
})

test('the actual workflow does not fetch E2B/DB/ACME credentials or run another acceptance in workspace-review mode', () => {
  const source = readFileSync(new URL('../../.github/workflows/task-secret-acceptance.yml', import.meta.url), 'utf8')
  assert.ok(source.includes('options: [preflight, execute, workspace-review]'))
  const primary = source.split('\n  acceptance:')[1].split('\n  factory:')[0]
  const secretSteps = primary.split('\n      - name:').filter(step => step.includes('secret-name:'))
  for (const step of secretSteps) {
    const name = /secret-name: ([A-Z0-9_]+)/.exec(step)?.[1]
    if (['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'].includes(name)) continue
    assert.ok(['MIKKA_DATABASE_URL', 'E2B_API_KEY'].includes(name))
    assert.ok(step.includes("if: env.ACCEPTANCE_MODE == 'execute'"))
  }
  assert.equal(primary.includes('ACME_DEMO'), false)
  assert.ok(primary.indexOf('await attestCodingWorkspace(process.env)') < primary.indexOf('secret-name: SMOKE_OWNER_EMAIL'))
  const executeSteps = primary.split('\n      - name:').filter(step => /node --import tsx scripts\/acceptance\/(?:coding-workspace|task-secrets)\.mjs/.test(step)
    && !step.includes('--cleanup'))
  assert.equal(executeSteps.length, 2)
  const workspaceStep = executeSteps.find(step => step.includes('coding-workspace.mjs --execute'))
  const secretStep = executeSteps.find(step => step.includes('task-secrets.mjs'))
  assert.ok(workspaceStep.includes("if: env.ACCEPTANCE_MODE == 'workspace-review'"))
  assert.ok(secretStep.includes("if: env.ACCEPTANCE_MODE != 'workspace-review'"))
  assert.equal(workspaceStep.includes('task-secrets.mjs'), false)
  assert.equal(secretStep.includes('coding-workspace.mjs'), false)
  assert.ok(primary.includes("if: always() && env.ACCEPTANCE_MODE == 'workspace-review'"))
  assert.ok(primary.includes('coding-workspace.mjs --cleanup'))
  assert.ok(source.split('\n  factory:')[1].includes("inputs.mode == 'execute'"))
})
