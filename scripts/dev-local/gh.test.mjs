import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fixtureGh } from './gh.mjs'
import { startMvpServices } from '../../tests/mvp/services.mjs'

test('real agent-shaped push, gh PR and exact-head receipt use only the fixture and explicit synthetic CI', async () => {
  const services = await startMvpServices(0)
  const directory = await mkdtemp(join(tmpdir(), 'mikka-local-gh-'))
  const env = { GH_REPO: 'mikka-e2e/core-loop', GH_HOST: 'github.com', GH_TOKEN: 'mvp-synthetic-installation-run' }
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const output = []
  const gh = args => fixtureGh(args, { env, origin: services.origin, gitRun: git, output: value => output.push(value) })
  try {
    const fixture = await (await fetch(`${services.origin}/scenario`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marker: `mvp-${randomUUID()}`, title: 'Agent gh fixture', harness: 'any' }) })).json()
    git(['clone', fixture.barePath, '.'])
    git(['checkout', '-b', 'mikka/fixture-1'])
    await appendFile(join(directory, 'README.md'), '\nReal fixture delivery\n')
    git(['add', 'README.md'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Append fixture delivery'])
    git(['push', 'origin', 'HEAD:mikka/fixture-1'])
    const commit = git(['rev-parse', 'HEAD'])
    const token = await fetch(`${services.origin}/github/app/installations/99/access_tokens`, { method: 'POST', headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' }, body: JSON.stringify({ repository_ids: [789], permissions: { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } }) })
    assert.equal(token.status, 200)
    const issued = await token.json()
    assert.equal(issued.token, env.GH_TOKEN)
    assert.ok(Date.parse(issued.expires_at) > Date.now() + 40 * 60_000)
    await gh(['--version'])
    assert.match(output.at(-1), /local-fixture/)
    await gh(['auth', 'status'])
    assert.match(output.at(-1), /Local fixture authenticated/)
    await gh(['repo', 'view', env.GH_REPO, '--json', 'name,defaultBranchRef'])
    assert.equal(JSON.parse(output.at(-1)).defaultBranchRef.name, 'trunk')
    await gh(['pr', 'list', '--repo', env.GH_REPO, '--head', 'mikka/fixture-1', '--state', 'all', '--json', 'number,url'])
    assert.deepEqual(JSON.parse(output.at(-1)), [])
    const issueId = randomUUID()
    await gh(['pr', 'create', '--title', 'Fixture delivery', '--body', `A real local change.\n\n<!-- mikka-issue:${issueId} -->`, '--base', 'trunk', '--head', 'mikka/fixture-1'])
    assert.equal(output.at(-1), 'https://github.com/mikka-e2e/core-loop/pull/41')
    await gh(['pr', 'list', '--repo', env.GH_REPO, '--head', 'mikka/fixture-1', '--state', 'all', '--json', 'number,url'])
    assert.equal(JSON.parse(output.at(-1))[0].number, 41)
    await gh(['pr', 'view', 'mikka/fixture-1', '--repo', env.GH_REPO, '--json', 'headRefOid,body'])
    assert.equal(JSON.parse(output.at(-1)).headRefOid, commit)
    await gh(['pr', 'checks', 'https://github.com/mikka-e2e/core-loop/pull/41', '--watch'])
    assert.match(output.at(-1), /synthetic CI.*pass/)
    await gh(['api', 'graphql', '-f', 'query=query($owner:String!,$repository:String!,$commit:GitObjectID!){repository(owner:$owner,name:$repository){object(oid:$commit){... on Commit {oid statusCheckRollup{state}}}}}', '-f', 'owner=mikka-e2e', '-f', 'repository=core-loop', '-f', `commit=${commit}`])
    const checked = JSON.parse(output.at(-1)).data.repository.object
    assert.equal(checked.oid, commit)
    assert.equal(checked.statusCheckRollup.state, 'SUCCESS')
    // A server without a repository verification command preserves not_run
    // and legitimately downgrades this task's PR after the agent receipt.
    const pr = await (await fetch(`${services.origin}/github/repos/${env.GH_REPO}/pulls/41`, { headers: { authorization: `Bearer ${env.GH_TOKEN}` } })).json()
    assert.equal(typeof pr.node_id, 'string')
    const conversion = await fetch(`${services.origin}/github/graphql`, { method: 'POST', headers: { authorization: 'Bearer mvp-synthetic-installation-write', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }', variables: { id: pr.node_id } }) })
    assert.equal(conversion.status, 200)
    assert.deepEqual((await conversion.json()).data.convertPullRequestToDraft.pullRequest, { id: pr.node_id, isDraft: true })
    const evidence = await (await fetch(`${services.origin}/observations`)).json()
    assert.equal(evidence.pullRequests.length, 1)
    assert.equal(evidence.pullRequests[0].draft, true)
    assert.equal(evidence.errors.length, 0)
    assert.ok(evidence.observations.some(item => item.kind === 'synthetic-ci-checked' && item.commit === commit))
    await assert.rejects(fixtureGh(['pr', 'view'], { env: { ...env, GH_TOKEN: 'real-token' } }), /fixture credentials required/)
    await assert.rejects(gh(['pr', 'view', 'https://github.com/another/repository/pull/1']), /fixture pull request required/)
    await assert.rejects(gh(['api', 'repos/another/repository/pulls']), /fixture API/)
  } finally { await services.close(); await rm(directory, { recursive: true, force: true }) }
})
