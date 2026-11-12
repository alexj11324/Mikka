import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { attachmentRelease } from './task-attachment-release.mjs'

const repo = 'alexj11324/Mikka'
const api = 'https://api.github.com/repos/' + repo
const sha = 'a'.repeat(40)
const version = 'https://app.aspectlylabs.com/mikka/api/version'
const owner = { full_name: repo, owner: { login: 'alexj11324' } }
const env = {
  GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
  GITHUB_WORKFLOW_REF: repo + '/.github/workflows/task-attachment-production.yml@refs/heads/main',
  GITHUB_SHA: sha, GH_TOKEN: 'fixture',
}
const run = {
  id: 7, run_attempt: 2, url: api + '/actions/runs/7', event: 'push',
  repository: owner, head_repository: owner, head_branch: 'main', head_sha: sha,
  path: '.github/workflows/web-deploy.yml', name: 'Web deploy', status: 'completed', conclusion: 'success',
}
const event = { action: 'completed', repository: owner, workflow_run: run }
const steps = ['Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
  'Verify the public production version before releasing the deployment queue'].map(name => ({ name, status: 'completed', conclusion: 'success' }))
const job = { id: 9, run_id: 7, head_sha: sha, name: 'deploy', status: 'completed', conclusion: 'success', steps }
const issue = { number: 1966, state: 'open', repository_url: api, url: api + '/issues/1966' }

function fixture(overrides = {}) {
  const reads = []
  const replies = {
    [issue.url]: issue, [run.url]: run,
    [run.url + '/attempts/2/jobs?per_page=100']: { total_count: 1, jobs: [job] },
    [api + '/git/ref/heads/main']: { ref: 'refs/heads/main', object: { type: 'commit', sha } },
    [version]: { build: sha }, ...overrides,
  }
  return { reads, fetch: async (url, options) => {
    assert.equal(options.method ?? 'GET', 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, url.startsWith(api + '/') ? 'Bearer fixture' : undefined)
    assert.ok(Object.hasOwn(replies, url))
    reads.push(url)
    return Response.json(typeof replies[url] === 'function' ? replies[url]() : replies[url])
  } }
}

test('only the open issue and a genuinely published exact main release authorize the fixed driver', async () => {
  const f = fixture()
  assert.equal(await attachmentRelease(env, event, f.fetch), true)
  assert.equal(f.reads[0], issue.url)
  assert.equal(f.reads.at(-1), issue.url)
  const closed = fixture({ [issue.url]: { ...issue, state: 'closed' } })
  assert.equal(await attachmentRelease(env, event, closed.fetch), false)
  assert.deepEqual(closed.reads, [issue.url])
  let issueReads = 0
  const closing = fixture({ [issue.url]: () => ({ ...issue, state: ++issueReads === 1 ? 'open' : 'closed' }) })
  assert.equal(await attachmentRelease(env, event, closing.fetch), false)
})

test('foreign, pull-request, stale and skipped releases never authorize a production write', async () => {
  for (const [environment, trigger] of [
    [{ ...env, GITHUB_EVENT_NAME: 'pull_request' }, event],
    [{ ...env, GITHUB_WORKFLOW_REF: repo + '/.github/workflows/other.yml@refs/heads/main' }, event],
    [env, { ...event, workflow_run: { ...run, event: 'pull_request' } }],
    [env, { ...event, workflow_run: { ...run, head_repository: { full_name: 'other/fork' } } }],
  ]) {
    const f = fixture()
    await assert.rejects(attachmentRelease(environment, trigger, f.fetch))
    assert.equal(f.reads.length, 0)
  }
  for (const replacement of [
    { [issue.url]: { ...issue, number: 1415 } },
    { [run.url]: { ...run, run_attempt: 3 },
      [run.url + '/attempts/3/jobs?per_page=100']: { total_count: 1, jobs: [job] } },
    { [api + '/git/ref/heads/main']: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } } },
    { [version]: { build: 'b'.repeat(40) } },
    { [run.url + '/attempts/2/jobs?per_page=100']: { total_count: 1, jobs: [{ ...job,
      steps: steps.map(s => ({ ...s, conclusion: 'skipped' })) }] } },
  ]) {
    await assert.rejects(attachmentRelease(env, event, fixture(replacement).fetch))
  }
})

test('pull requests run only offline tests and every smoke lookup waits for the release proof', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/task-attachment-production.yml', import.meta.url), 'utf8')
  const [pr, live] = workflow.split('\n  roundtrip:\n')
  assert.match(pr, /if: github.event_name == 'pull_request'/)
  assert.match(pr, /node --test scripts\/acceptance\/task-attachment-\*\.test\.mjs/)
  assert.doesNotMatch(pr, /Infisical|id-token: write|\bsecrets\.|GH_TOKEN|pull_request_target|workflow_dispatch/)
  assert.match(live, /github.event_name == 'workflow_run' && github.event.workflow_run.event == 'push'/)
  const secretSteps = live.split('      - name: ').filter(step => step.includes('uses: Infisical/'))
  assert.deepEqual(secretSteps.map(step => step.match(/secret-name: (\w+)/)?.[1]), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  assert.ok(secretSteps.every(step => step.includes("if: steps.release.outputs.ready == 'true'")))
  assert.match(live, /if: steps.current.outputs.ready == 'true'\s+run: node scripts\/acceptance\/task-attachment-production\.mjs/)
})
