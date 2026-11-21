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
  GITHUB_REPOSITORY: repo, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: repo + '/.github/workflows/task-attachment-production.yml@refs/heads/main',
  GITHUB_SHA: sha, GH_TOKEN: 'fixture',
}
const event = { repository: owner }
const issue = { number: 1966, state: 'open', repository_url: api, url: api + '/issues/1966' }

function fixture(overrides = {}) {
  const reads = []
  const replies = {
    [issue.url]: issue,
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

test('only the open issue and current main served live authorize the fixed driver', async () => {
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

test('foreign, pull-request and stale targets never authorize a production write', async () => {
  for (const [environment, trigger] of [
    [{ ...env, GITHUB_EVENT_NAME: 'pull_request' }, event],
    [{ ...env, GITHUB_WORKFLOW_REF: repo + '/.github/workflows/other.yml@refs/heads/main' }, event],
    [{ ...env, GITHUB_EVENT_NAME: 'workflow_run' }, event],
    [env, { repository: { full_name: 'other/fork' } }],
  ]) {
    const f = fixture()
    await assert.rejects(attachmentRelease(environment, trigger, f.fetch))
    assert.equal(f.reads.length, 0)
  }
  for (const replacement of [
    { [issue.url]: { ...issue, number: 1415 } },
    { [api + '/git/ref/heads/main']: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } } },
    { [version]: { build: 'b'.repeat(40) } },
  ]) {
    await assert.rejects(attachmentRelease(env, event, fixture(replacement).fetch))
  }
})

test('pull requests run only offline tests and every smoke lookup waits for the release proof', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/task-attachment-production.yml', import.meta.url), 'utf8')
  const [pr, live] = workflow.split('\n  roundtrip:\n')
  assert.match(pr, /if: github.event_name == 'pull_request'/)
  assert.match(pr, /node --test scripts\/acceptance\/task-attachment-\*\.test\.mjs/)
  assert.doesNotMatch(pr, /Infisical|id-token: write|\bsecrets\.|GH_TOKEN|pull_request_target|workflow_run/)
  assert.match(live, /github.event_name == 'workflow_dispatch'/)
  const secretSteps = live.split('      - name: ').filter(step => step.includes('uses: Infisical/'))
  assert.deepEqual(secretSteps.map(step => step.match(/secret-name: (\w+)/)?.[1]), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  assert.ok(secretSteps.every(step => step.includes("if: steps.release.outputs.ready == 'true'")))
  assert.match(live, /if: steps.current.outputs.ready == 'true'\s+run: node scripts\/acceptance\/task-attachment-production\.mjs/)
})
