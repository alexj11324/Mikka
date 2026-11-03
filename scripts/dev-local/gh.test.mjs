import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, appendFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fixtureGh } from './gh.mjs'
import { createCheckCommand } from '../../packages/daemon/src/agents/check-command.mjs'
import { startMvpServices } from '../../tests/mvp/services.mjs'

test('real agent-shaped push, gh PR and exact-head receipt use only the fixture and explicit synthetic CI', async () => {
  let tokenRequests=0
  const services = await startMvpServices(0,{routes:async(request,response,url)=>{
    if(url.pathname!=='/api/runs/github-token')return false
    assert.equal(request.headers.authorization,'Bearer fixture-check-token');tokenRequests++
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({token:'mvp-synthetic-installation-run',expiresAt:new Date(Date.now()+3600000).toISOString()}));return true
  }})
  const directory = await mkdtemp(join(tmpdir(), 'mikka-local-gh-'))
  const env = { GH_REPO: 'mikka-e2e/core-loop', GH_HOST: 'github.com', GH_TOKEN: 'mvp-synthetic-installation-run' }
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  const output = []
  const gh = args => fixtureGh(args, { env, origin: services.origin, gitRun: git, output: value => output.push(value) })
  const hostGh = args => fixtureGh(args, { env: { ...env, GH_REPO: undefined }, origin: services.origin, gitRun: git, output: value => output.push(value) })
  try {
    const fixture = await (await fetch(`${services.origin}/scenario`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marker: `mvp-${randomUUID()}`, title: 'Agent gh fixture', harness: 'any', verification: 'git-diff' }) })).json()
    const identity = await fetch(`${services.origin}/github/user`, { headers: { authorization: `Bearer ${env.GH_TOKEN}` } })
    assert.equal(identity.status, 200, 'The run token must resolve its synthetic user identity')
    assert.equal((await identity.json()).id, 456)
    git(['clone', fixture.barePath, '.'])
    git(['checkout', '-b', 'mikka/fixture-1'])
    await appendFile(join(directory, 'README.md'), '\nReal fixture delivery\n')
    git(['add', 'README.md'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Append fixture delivery'])
    git(['push', 'origin', 'HEAD:mikka/fixture-1'])
    const commit = git(['rev-parse', 'HEAD'])
    execFileSync('make', ['test'], { cwd: directory, stdio: 'pipe' })
    const token = await fetch(`${services.origin}/github/app/installations/99/access_tokens`, { method: 'POST', headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' }, body: JSON.stringify({ repository_ids: [789] }) })
    assert.equal(token.status, 200)
    const issued = await token.json()
    assert.equal(issued.token, env.GH_TOKEN)
    assert.ok(Date.parse(issued.expires_at) > Date.now() + 40 * 60_000)
    await fixtureGh(['repo', 'view', env.GH_REPO, '--json', 'name'], { env: { GH_TOKEN: env.GH_TOKEN, GH_HOST: env.GH_HOST }, origin: services.origin, gitRun: git, output: value => output.push(value) })
    assert.equal(JSON.parse(output.at(-1)).name, 'core-loop', 'Host receipts use explicit repository arguments without GH_REPO')
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
    await hostGh(['pr', 'view', 'mikka/fixture-1', '--repo', env.GH_REPO, '--json', 'headRefOid,body'])
    assert.equal(JSON.parse(output.at(-1)).headRefOid, commit)
    const trustedGh = join(directory,'.git','fixture-gh.mjs')
    await writeFile(trustedGh,`#!/usr/bin/env node\nimport {fixtureGh} from ${JSON.stringify(new URL('./gh.mjs',import.meta.url).href)};fixtureGh(process.argv.slice(2),{origin:${JSON.stringify(services.origin)}}).catch(()=>process.exit(1));\n`)
    await chmod(trustedGh,0o700)
    const githubConfig=join(directory,'.git','task-github.json')
    await writeFile(githubConfig,JSON.stringify({gh:trustedGh,endpoint:services.origin+'/api/runs/github-token',repository:env.GH_REPO,runToken:'fixture-check-token',issueId}),{mode:0o600})
    const inspection=createCheckCommand({worktree:directory,gitDir:join(directory,'.git'),candidateSha:commit,infer:true,githubConfig})
    try {
      const deliveryUrl=output.find(value=>value.startsWith("https://github.com/"))
      assert.equal((await inspection.inspect({pullRequest:'https://github.com/another/repository/pull/41'})).isError,true)
      assert.equal(tokenRequests,0,'A foreign repository is rejected before credential issuance')
      const inspected=await inspection.inspect({pullRequest:deliveryUrl})
      assert.equal(inspected.isError,undefined)
      const evidence=JSON.parse(inspected.content[0].text)
      assert.equal(evidence.sha,commit);assert.equal(evidence.readOnly,true)
      assert.match(evidence.diff,/Real fixture delivery/)
      assert.equal(evidence.pullRequest.headSha,commit);assert.equal(evidence.pullRequest.taskBound,true)
      assert.equal(evidence.pullRequest.headRefName,'mikka/fixture-1');assert.equal(evidence.pullRequest.baseRefName,'trunk')
      assert.deepEqual(evidence.pullRequest.ci,{sha:commit,state:'SUCCESS'})
      assert.ok(evidence.pullRequest.body.endsWith(`<!-- mikka-issue:${issueId} -->`))
      assert.equal(tokenRequests,1)
      const base=git(['rev-parse','HEAD^'])
      execFileSync('git',['--git-dir',fixture.barePath,'update-ref','refs/heads/mikka/fixture-1',base,commit])
      try {assert.equal((await inspection.inspect({pullRequest:deliveryUrl})).isError,true,'A moved PR head cannot supply evidence for the old candidate')}
      finally {execFileSync('git',['--git-dir',fixture.barePath,'update-ref','refs/heads/mikka/fixture-1',commit,base])}
      assert.equal((await inspection.inspect({pullRequest:'https://github.com/another/repository/pull/41'})).isError,true)
      assert.equal(tokenRequests,1,'A foreign repository is rejected before credential issuance')
    } finally {inspection.close()}

    await gh(['pr', 'checks', 'https://github.com/mikka-e2e/core-loop/pull/41', '--watch'])
    assert.match(output.at(-1), /synthetic CI.*pass/)
    await hostGh(['api', 'graphql', '-f', 'query=query($owner:String!,$repository:String!,$commit:GitObjectID!){repository(owner:$owner,name:$repository){object(oid:$commit){... on Commit {oid statusCheckRollup{state}}}}}', '-f', 'owner=mikka-e2e', '-f', 'repository=core-loop', '-f', `commit=${commit}`])
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
