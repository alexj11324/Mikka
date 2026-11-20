import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const source = await readFile(new URL('../../.github/workflows/cloudflare-app-deploy.yml', import.meta.url), 'utf8')
const workflow = yaml.load(source)

test('main build completion uses a non-cancelling shared deployment queue and preserves manual phases', () => {
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Cloudflare API image'], types: ['completed'], branches: ['main'] })
  assert.deepEqual(workflow.concurrency, { group: 'cloudflare-application-deployment', queue: 'max', 'cancel-in-progress': false })
  const phases = workflow.on.workflow_dispatch.inputs.phase.options
  for (const phase of ['production-migrate-database', 'gateway-observe', 'service-production', 'pipeline-stage', 'pipeline-rollback'])
    assert.ok(phases.includes(phase))
  assert.match(workflow.jobs['deploy-application'].if, /workflow_dispatch/)
  assert.match(workflow.jobs['deploy-application'].if, /!startsWith\(inputs.phase, 'pipeline-'\)/)
  assert.equal(workflow.jobs['deploy-application'].concurrency, undefined)
})

test('only actual successful same-repository main pushes or explicit recovery acquire staging credentials', () => {
  const job = workflow.jobs.pipeline
  for (const required of ["github.repository_id == '1427517699'", "github.actor_id == '183887963'", "github.ref == 'refs/heads/main'",
    "github.event_name == 'workflow_run'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.conclusion == 'success'",
    'github.event.workflow_run.head_repository.id == github.event.repository.id']) assert.ok(job.if.includes(required))
  assert.equal(job.environment, 'cloudflare-runtime-release')
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' })
  const select = job.steps.find(step => step.id === 'select')
  assert.equal(select.run, 'node scripts/release/pipeline-inputs.mjs')
  const token = job.steps.find(step => step.name === 'Read the existing Cloudflare deployment identity')
  assert.equal(token.if, "steps.select.outputs.status == 'selected'")
  const apply = job.steps.find(step => step.name === 'Deploy and verify staged service manifest')
  assert.equal(apply.run, 'node operations/public-release.mjs')
  assert.equal(apply['working-directory'], 'operations')
  assert.equal(apply.if, "steps.select.outputs.status == 'selected'")
  assert.doesNotMatch(source, /GITHUB_EVENT_NAME:\s|GITHUB_REF:\s|GITHUB_ACTOR_ID:\s/)
})

test('public records cannot receive the private rollback receipt or runtime credentials', () => {
  const upload = workflow.jobs.pipeline.steps.find(step => step.name === 'Upload pipeline receipts')
  assert.equal(upload.with.name, 'deploy-pipeline-${{ github.run_id }}-${{ github.run_attempt }}')
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.deepEqual(upload.with.path.trim().split('\n'), [
    '${{ runner.temp }}/deploy-pipeline/release-manifest.json',
    '${{ runner.temp }}/deploy-pipeline/previous-manifest.json',
    '${{ runner.temp }}/deploy-pipeline/pipeline-summary.json',
  ])
  const record = workflow.jobs['pipeline-record']
  assert.deepEqual(record.permissions, { contents: 'read', actions: 'read', deployments: 'write', issues: 'write' })
  assert.equal(record.needs, 'pipeline')
  assert.doesNotMatch(JSON.stringify(record), /Infisical|HOSTED_UI|CLOUDFLARE_API_TOKEN|source-token|id-token|private\.json/)
})
