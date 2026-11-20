// One GitHub HTTP boundary for MVP, local-loop and SDK/client integration tests.
// Git history, commits, merge conflicts and compare-and-swap stay real and local.
import assert from 'node:assert/strict'
import { bodyJson, json, requestRecord } from './http.mjs'

const REPO_PATH = '/repos/mikka-e2e/core-loop'
const REPOSITORY_ID = 789
const READ_TOKEN = 'mvp-synthetic-installation-read'
const WRITE_TOKEN = 'mvp-synthetic-installation-write'
const RUN_TOKEN = 'mvp-synthetic-installation-run'

export function createGitHubRoutes({ getScenario, getPullRequests, observe, git, origin }) {
  const requests = [], rules = new Map()
  const MVP_SERVICES = origin
  async function routes(request, response, url, requestId) {
    if (!url.pathname.startsWith('/github/')) return false
    const scenario = getScenario(), pullRequests = getPullRequests()
    const record = requestRecord(request, url)
    requests.push(record)
    const readBody = async request => { const value = await bodyJson(request); record.body = value; return value }
    const reply = (value, status = 200) => json(response, value, status, { 'x-mvp-request-id': requestId })
  assert.ok(scenario, 'GitHub called before the fixture scenario exists')
  const githubUser = { id: scenario.githubAccountId, login: `mvp-owner-${scenario.githubAccountId}` }
  const path = decodeURIComponent(url.pathname.slice('/github'.length))
  const method = request.method ?? 'GET'
  observe({ kind: 'github-request', requestId, method, path })
  const bearer = request.headers.authorization
  const readAccess = () => assert.ok([READ_TOKEN, RUN_TOKEN,'mikka-local-synthetic-user-token'].some(token => bearer === `Bearer ${token}`), 'Expected repository read token')
  const writeAccess = () => assert.ok([WRITE_TOKEN, RUN_TOKEN,'mikka-local-synthetic-user-token'].some(token => bearer === `Bearer ${token}`), 'Expected repository PR token')
  const appAccess = () => assert.match(bearer ?? '', /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Expected an App JWT')
  if (['/user','/user/installations','/user/installations/99/repositories'].includes(path) && method === 'GET') {
    assert.equal(bearer,'Bearer mikka-local-synthetic-user-token','Expected local user authorization');
    if (path === '/user') return reply(githubUser);
    if (path === '/user/installations') return reply({ installations: [{ id:99,app_id:Number(process.env.GITHUB_APP_ID ?? '123'),account:{login:'mikka-e2e'},suspended_at:null }] });
    return reply({ repositories: [{id:REPOSITORY_ID,full_name:'mikka-e2e/core-loop',private:false,description:'Disposable local acceptance repository',homepage:null,pushed_at:null}] });
  }
  if (path === `${REPO_PATH}/installation` && method === 'GET') {
    appAccess()
    return reply({ id: 99, suspended_at: null, permissions: { pull_requests: 'write', contents: 'write' } })
  }
  if (path === '/app/installations/99/access_tokens' && method === 'POST') {
    appAccess()
    const input = await readBody(request)
    // A run's token names the repository only and inherits the installation's permissions (#853).
    if (!input.permissions) {
      assert.deepEqual(input, { repository_ids: [REPOSITORY_ID] })
      return reply({ token: RUN_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    }
    if (input.permissions?.pull_requests === 'write') {
      assert.deepEqual(input, { repository_ids: [REPOSITORY_ID], permissions: { metadata: 'read', pull_requests: 'write' } })
      return reply({ token: WRITE_TOKEN })
    }
    assert.deepEqual(input, { repositories: ['core-loop'], permissions: { metadata: 'read', contents: 'read' } })
    return reply({ token: READ_TOKEN })
  }
  if (path === `/user/${githubUser.id}` && method === 'GET') { readAccess(); return reply(githubUser) }
  if (path === `${REPO_PATH}/collaborators/${githubUser.login}/permission` && method === 'GET') { readAccess(); return reply({ permission: 'write', user: githubUser }) }
  if (path === REPO_PATH && method === 'GET') { readAccess(); return reply({ id: REPOSITORY_ID, full_name: 'mikka-e2e/core-loop', default_branch: 'trunk', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false }) }
  const currentCommit = branch => git(scenario.barePath, ['rev-parse', '--verify', `refs/heads/${branch}`])
  const mergeState = async pr => {
    const rule = rules.get(pr.number) ?? {}
    if (rule.conflict) return 'dirty'
    if ((rule.requiredReview && !rule.approved) || (rule.protected && !rule.checksPassed)) return 'blocked'
    try { await git(scenario.barePath, ['merge-tree', '--write-tree', await currentCommit(pr.base.ref), await currentCommit(pr.head.ref)]) }
    catch (error) { if (error.code === 1) return 'dirty'; throw error }
    return 'clean'
  }
  const checkCommit = async commit => {
    assert.match(commit, /^[a-f0-9]{40}$/)
    assert.equal(await git(scenario.barePath, ['rev-parse', '--verify', `${commit}^{commit}`]), commit)
    // This is a real fixture whitespace check, explicitly synthetic CI.
    // It establishes no claim about GitHub Actions or production checks.
    await git(scenario.barePath, ['diff', '--check', 'trunk', commit])
    observe({ kind: 'synthetic-ci-checked', commit, name: 'Local fixture diff (synthetic CI)' })
    return { state: 'SUCCESS', contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'Local fixture diff (synthetic CI)', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `${MVP_SERVICES}/observations` }] } }
  }
  const graphPull = async pr => {
    const oid = await currentCommit(pr.head.ref), state = await mergeState(pr), rule = rules.get(pr.number) ?? {}
    const rollup = await checkCommit(oid)
    return { number: pr.number, title: pr.title, bodyText: pr.body ?? '', state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
      isDraft: pr.draft, createdAt: pr.created_at ?? '2026-11-20T12:00:00Z', updatedAt: pr.updated_at ?? '2026-11-20T12:00:00Z',
      additions: 1, deletions: 0, changedFiles: 1, headRefName: pr.head.ref, baseRefName: pr.base.ref, headRefOid: oid,
      mergeStateStatus: state.toUpperCase(), mergeable: state === 'dirty' ? 'CONFLICTING' : 'MERGEABLE',
      reviewDecision: rule.requiredReview ? rule.approved ? 'APPROVED' : 'REVIEW_REQUIRED' : null,
      author: null, labels: { nodes: [] }, commits: { nodes: [{ commit: { oid, statusCheckRollup: {
        ...rollup, contexts: { ...rollup.contexts, pageInfo: { hasNextPage: false } },
      } } }] }, reviews: { nodes: rule.approved ? [{ author: { login: 'fixture-reviewer' }, state: 'APPROVED', submittedAt: '2026-11-20T12:00:00Z' }] : [] } }
  }
  if (path === '/graphql' && method === 'POST') {
    const input = await readBody(request)
    if (input.query === 'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }') {
      writeAccess()
      const pr = pullRequests.find(value => value.node_id === input.variables?.id)
      assert.ok(pr, 'Draft conversion requires an existing fixture PR')
      pr.draft = true
      observe({ kind: 'pull-request-converted-to-draft', requestId, number: pr.number })
      return reply({ data: { convertPullRequestToDraft: { pullRequest: { id: pr.node_id, isDraft: true } } } })
    }
    readAccess()
    assert.ok(typeof input.query === 'string' && !/\bmutation\b/.test(input.query), 'Fixture GraphQL is read-only')
    const variables = input.variables ?? input
    assert.equal(variables.owner, 'mikka-e2e'); assert.equal(variables.repository ?? variables.name, 'core-loop')
    if (/\bquery PullDirectory\b/.test(input.query)) {
      assert.ok(variables.after === undefined || variables.after === null, 'Fixture directory has one page')
      const nodes = await Promise.all(pullRequests.map(graphPull))
      const selected = nodes.filter(pr => !variables.states || variables.states.includes(pr.state))
      return reply({ data: { repository: { databaseId: REPOSITORY_ID, nameWithOwner: 'mikka-e2e/core-loop',
        pullRequests: { totalCount: selected.length, nodes: selected, pageInfo: { hasNextPage: false, endCursor: null } } } } })
    }
    if (/\bquery PullDetail\b/.test(input.query)) {
      const pr = pullRequests.find(pr => pr.number === variables.number)
      return reply({ data: { repository: { databaseId: REPOSITORY_ID, nameWithOwner: 'mikka-e2e/core-loop', pullRequest: pr ? await graphPull(pr) : null } } })
    }
    const commit = variables.commit
    return reply({ data: { repository: { object: { oid: commit, statusCheckRollup: await checkCommit(commit) } } } })
  }
  if (path.startsWith(`${REPO_PATH}/git/commits/`) && method === 'GET') {
    readAccess()
    const commit = path.slice(`${REPO_PATH}/git/commits/`.length)
    assert.match(commit, /^[a-f0-9]{40}$/)
    return reply({ sha: await git(scenario.barePath, ['rev-parse', '--verify', `${commit}^{commit}`]), tree: { sha: await git(scenario.barePath, ['rev-parse', `${commit}^{tree}`]) } })
  }
  if (new RegExp(`^${REPO_PATH}/pulls/[0-9]+$`).test(path) && method === 'GET') {
    writeAccess()
    const pr = pullRequests.find(value => value.number === Number(path.split('/').at(-1)))
    if (!pr) return reply({ message: 'Fixture pull request not found' }, 404)
    return reply({ ...pr, mergeable_state: await mergeState(pr), head: { ...pr.head, sha: await currentCommit(pr.head.ref) } })
  }
  if (new RegExp(`^${REPO_PATH}/pulls/[0-9]+/merge$`).test(path) && method === 'PUT') {
    // Factory acceptance acts as the person; installation/run tokens may
    // publish a PR but cannot stand in for the person's merge decision.
    if (bearer !== 'Bearer mikka-local-synthetic-user-token') return reply({ message: 'The fixture owner must accept the pull request' }, 403)
    const pr = pullRequests.find(value => value.number === Number(path.split('/').at(-2)))
    if (!pr) return reply({ message: 'Fixture pull request not found' }, 404)
    const input = await readBody(request), head = await currentCommit(pr.head.ref)
    if (input.sha !== head) return reply({ message: 'Head branch was modified' }, 409)
    if (input.merge_method !== 'merge') return reply({ message: 'This fixture supports merge commits only' }, 422)
    const result = sha => ({ sha, merged: true, message: 'Pull request successfully merged' })
    if (pr.merged) return reply(result(pr.merge_commit_sha))
    if (pr.state !== 'open' || pr.draft) return reply({ message: 'Pull request is not mergeable' }, 405)
    const rule = rules.get(pr.number) ?? {}
    if (rule.conflict) return reply({ message: 'Merge conflict' }, 405)
    if (rule.requiredReview && !rule.approved) return reply({ message: 'Required approving review is missing' }, 405)
    if (rule.protected && !rule.checksPassed) return reply({ message: 'Protected branch check failed' }, 405)
    const base = await currentCommit(pr.base.ref)
    let tree
    try { tree = await git(scenario.barePath, ['merge-tree', '--write-tree', base, head]) }
    catch (error) {
      if (error.code === 1) return reply({ message: 'Merge conflict' }, 405)
      throw error
    }
    const commit = await git(scenario.barePath, ['-c', 'user.name=Mikka fixture owner', '-c', 'user.email=fixture-owner@example.test',
      'commit-tree', tree, '-p', base, '-p', head, '-m', `Merge pull request #${pr.number}`])
    // Compare-and-swap the real default branch; a concurrent update cannot
    // be reported as a successful merge of this reviewed candidate.
    try { await git(scenario.barePath, ['update-ref', `refs/heads/${pr.base.ref}`, commit, base]) }
    catch { return reply({ message: 'Base branch was modified' }, 409) }
    Object.assign(pr, { state: 'closed', merged: true, merged_at: new Date().toISOString(), merge_commit_sha: commit })
    observe({ kind: 'pull-request-merged', requestId, number: pr.number, headSha: head, mergeCommitSha: commit })
    return reply(result(commit))
  }
  if (new RegExp(`^${REPO_PATH}/commits/[a-f0-9]{40}/check-runs$`).test(path) && method === 'GET') {
    readAccess()
    const commit = path.split('/').at(-2)
    const result = await checkCommit(commit)
    return reply({ total_count: 1, check_runs: [{ name: 'Local fixture diff (synthetic CI)', head_sha: commit, status: 'completed', conclusion: 'success', html_url: `${MVP_SERVICES}/observations`, ...result }] })
  }
  if (path.startsWith(`${REPO_PATH}/git/ref/heads/`) && method === 'GET') {
    readAccess()
    const branch = path.slice(`${REPO_PATH}/git/ref/heads/`.length)
    assert.match(branch, /^mikka\/[a-z0-9-]+-[1-9][0-9]*$/)
    const sha = await git(scenario.barePath, ['rev-parse', '--verify', `refs/heads/${branch}`]).catch(() => null)
    if (!sha) return reply({ message: 'Branch was not pushed' }, 404)
    observe({ kind: 'pushed-branch', branch, sha })
    return reply({ object: { sha } })
  }
  if (path === `${REPO_PATH}/pulls` && method === 'GET') {
    writeAccess()
    const head = url.searchParams.get('head')
    assert.equal(url.searchParams.get('state'), 'all')
    return reply(await Promise.all(pullRequests.filter(pr => !head || `mikka-e2e:${pr.head.ref}` === head).map(async pr => ({ ...pr, head: { ...pr.head, sha: await currentCommit(pr.head.ref) } }))))
  }
  if (path === `${REPO_PATH}/pulls` && method === 'POST') {
    writeAccess()
    const input = await readBody(request)
    assert.match(input.head, /^mikka\/[a-z0-9-]+-[1-9][0-9]*$/)
    assert.equal(input.base, 'trunk', 'PR must use the actual origin default branch')
    assert.match(input.body, /<!-- mikka-issue:[a-f0-9-]{36} -->$/)
    const commit = await git(scenario.barePath, ['rev-parse', '--verify', `refs/heads/${input.head}`])
    if (scenario.harness === 'mock') assert.match(await git(scenario.barePath, ['show', `${commit}:MIKKA_MOCK.md`]), /Written by the real Mikka mock harness/)
    const message = await git(scenario.barePath, ['show', '-s', '--format=%B', commit])
    const runId = message.match(/Mikka-Run: ([a-f0-9-]{36})/)?.[1]
    const issueId = message.match(/Mikka-Issue: ([a-f0-9-]{36})/)?.[1]
    const bodyIssueId = input.body.match(/<!-- mikka-issue:([a-f0-9-]{36}) -->$/)?.[1]
    if (scenario.harness === 'mock') assert.ok(runId && issueId, 'The mock commit must carry its real run/task provenance')
    if (issueId) assert.equal(bodyIssueId, issueId)
    assert.equal(pullRequests.some(pr => pr.head.ref === input.head), false, 'A replay must find the existing PR')
    const number = 41 + pullRequests.length
    const pr = { number, node_id: `MVP_PR_${number}`, title: input.title, html_url: `https://github.com/mikka-e2e/core-loop/pull/${number}`, state: 'open', draft: input.draft === true, merged: false, merged_at: null, merge_commit_sha: null, body: input.body, head: { ref: input.head, repo: { id: REPOSITORY_ID } }, base: { ref: 'trunk', repo: { id: REPOSITORY_ID } } }
    pullRequests.push(pr)
    observe({ kind: 'pull-request-created', requestId, ...(runId ? { runId } : {}), issueId: bodyIssueId, commit, branch: input.head, url: pr.html_url })
    return reply(pr, 201)
  }
  throw new Error(`Unexpected GitHub operation: ${method} ${path}`)
  }
  return { routes, requests, rules }
}
