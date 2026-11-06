import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { inspectTeamMembership } from './production-team-membership-inspection.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const API = 'https://api.github.com/repos/alexj11324/Mikka'
const branch = 'ops/issue1415-team-membership-inspection'
const revision = '1'.repeat(40), application = '2'.repeat(40)
const repository = { id: 1427517699, full_name: 'alexj11324/Mikka', owner: { id: 183887963 } }
const one = '11111111-1111-4111-8111-111111111111'
const two = '22222222-2222-4222-8222-222222222222'
// Public identity supplied by Owner issue 1504 comment 6691409495; not a credential.
const documentedIdentity = 'alex@acme.aspectlylabs.com'
const actor = 'fixture-smoke-actor'
function fixture(options = {}) {
  const env = {
    GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_ID: String(repository.id),
    GITHUB_REPOSITORY_OWNER_ID: String(repository.owner.id), GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/' + branch, GITHUB_SHA: revision, GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'offline-only-gh-canary',
    SMOKE_OWNER_EMAIL: 'acceptance+mikka-smoke@example.test',
    SMOKE_OWNER_PASSWORD: 'offline-only-password-canary',
    ACME_DEMO_EMAIL: 'configured-admin@example.test',
    ...options.env,
  }
  const event = { ref: env.GITHUB_REF, after: env.GITHUB_SHA, deleted: false, repository }
  const calls = [], choices = [{ id: one, kind: 'team', name: 'PRIVATE-TEAM-NAME-ONE' }, { id: two, kind: 'team', name: 'PRIVATE-TEAM-NAME-TWO' }]
  if (options.malformedChoice) choices[0].id = '../auth/sign-out?unlisted=1'
  const members = [
    { userId: actor, email: env.SMOKE_OWNER_EMAIL, role: 'member', status: 'active' },
    { userId: 'fixture-policy-admin', email: documentedIdentity, role: 'admin', status: 'suspended' },
    { userId: 'fixture-configured-admin', email: env.ACME_DEMO_EMAIL, role: 'admin', status: 'active' },
  ]
  let signedIn = false, versionReads = 0
  const response = (url, value, init) => {
    const result = Response.json(value, init)
    Object.defineProperty(result, 'url', { value: url })
    return result
  }
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init })
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    if (url.startsWith(API)) {
      assert.equal(init.method, 'GET')
      assert.equal(init.headers.Authorization, 'Bearer ' + env.GH_TOKEN)
      assert.equal(init.headers.Cookie, undefined)
      if (url.endsWith('/actions/runs/123456789')) return response(url, {
        id: 123456789, event: 'push', head_branch: branch, head_sha: revision, run_attempt: 1,
        path: options.wrongWorkflow ? '.github/workflows/other.yml' : '.github/workflows/issue1415-team-membership-inspection.yml',
        status: 'in_progress', repository, head_repository: repository,
      })
      assert.equal(url, API + '/issues/1415')
      return response(url, { number: 1415, state: 'open', repository_url: API })
    }
    assert.equal(new URL(url).origin, ORIGIN)
    assert.equal(init.headers.Authorization, undefined)
    if (url === ORIGIN + '/mikka/api/version') {
      assert.equal(init.headers.Cookie, undefined)
      versionReads++
      return response(url, { build: options.changedBuild && versionReads === 2 ? '3'.repeat(40) : application })
    }
    if (url.endsWith('/auth/sign-in/email')) {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { email: env.SMOKE_OWNER_EMAIL.toLowerCase(), password: env.SMOKE_OWNER_PASSWORD })
      signedIn = true
      if (options.uncertainSignIn) throw new TypeError('PRIVATE-TRANSPORT-CANARY')
      return response(url, { success: true }, { headers: { 'Set-Cookie': 'mikka.session=offline-session-canary; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    }
    if (url.endsWith('/auth/sign-out')) {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), {})
      if (options.logoutFails) return response(url, { error: 'PRIVATE-BODY-CANARY' }, { status: 500 })
      signedIn = false
      return response(url, { success: true }, { headers: { 'Set-Cookie': 'mikka.session=; Path=/; Max-Age=0; Secure; HttpOnly' } })
    }
    if (url.endsWith('/auth/get-session')) {
      return response(url, signedIn && init.headers.Cookie?.includes('mikka.session=offline-session-canary')
        ? { user: { id: actor, email: options.wrongActor ? env.ACME_DEMO_EMAIL : env.SMOKE_OWNER_EMAIL } } : null)
    }
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    assert.ok(init.headers.Cookie?.includes('mikka.session=offline-session-canary'))
    const id = new URL(url).searchParams.get('workspace')
    const current = { currentUserId: actor, currentUser: { email: env.SMOKE_OWNER_EMAIL } }
    if (!id) {
      assert.equal(url, ORIGIN + '/mikka/api/workspace')
      return response(url, { ...current, choices, workspace: { id: one, kind: 'team' }, role: 'member' })
    }
    assert.ok([one, two].includes(id))
    if (options.candidateHttpFailure && id === two) return response(url, { error: 'PRIVATE-BODY-CANARY' }, { status: 503 })
    const selectedMembers = options.noMatches
      ? members.slice(0, 1)
      : members
    return response(url, { ...current, workspace: { id: options.wrongCandidate ? one : id, kind: 'team' },
      role: id === two && !options.noMatches ? 'admin' : 'member',
      members: options.badMember ? [{ ...selectedMembers[0], status: 'unknown' }] : selectedMembers,
      invitations: id === two && !options.noMatches ? [{ status: 'pending', email: 'PRIVATE-INVITEE@example.test', id: 'PRIVATE-INVITATION-ID' }] : [] })
  }
  return { env, event, calls, fetchImpl }
}
const run = f => inspectTeamMembership({ env: f.env, event: f.event, fetchImpl: f.fetchImpl })
const posts = f => f.calls.filter(call => call.method === 'POST')
function clean(report) {
  assert.equal(report.signOutAttempted, true)
  assert.equal(report.signOutSucceeded, true)
  assert.equal(report.anonymousAfterLogout, true)
  assert.equal(report.sessionClosed, true)
  assert.equal(report.cleanupSucceeded, true)
}

test('the diagnostic reads all listed teams, distinguishes documented/configured identities, and only posts signin/signout', async () => {
  const f = fixture(), report = await run(f)
  assert.equal(report.status, 'inspected')
  assert.equal(report.businessExecutionVerified, false)
  assert.equal(report.documentedPolicyEqualsConfiguredAcme, false)
  assert.equal(report.actorMatchesPolicy, false)
  assert.equal(report.actorMatchesConfiguredAcme, false)
  assert.equal(report.candidateCount, 2)
  assert.equal(report.candidatesRead, 2)
  assert.deepEqual(report.candidates[0].documentedPolicy, { members: 1, activeAdmins: 0, nonActorActiveAdmins: 0 })
  assert.deepEqual(report.candidates[0].configuredAcme, { members: 1, activeAdmins: 1, nonActorActiveAdmins: 1 })
  assert.equal(report.candidates[0].teamWorkspaceHash, createHash('sha256').update('team-workspace\0' + one).digest('hex'))
  assert.equal(report.candidates[0].visiblePendingInvitationCount, null)
  assert.equal(report.candidates[1].visiblePendingInvitationCount, 1)
  assert.equal(report.incomingUnjoinedInvitationsInspected, false)
  assert.equal(report.targetUnchanged, true)
  clean(report)
  assert.deepEqual(posts(f).map(call => new URL(call.url).pathname), ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.ok(f.calls.every(call => !call.url.includes('/rpc')))
  const text = JSON.stringify(report)
  for (const secret of [f.env.SMOKE_OWNER_EMAIL, f.env.SMOKE_OWNER_PASSWORD, f.env.ACME_DEMO_EMAIL,
    f.env.GH_TOKEN, documentedIdentity, one, two, actor, 'PRIVATE-', 'offline-session-canary']) {
    assert.equal(text.includes(secret), false)
  }
})
test('the configured administrator is blocked before sign-in', async () => {
  const f = fixture({ env: { ACME_DEMO_EMAIL: 'acceptance+mikka-smoke@example.test' } })
  const report = await run(f)
  assert.equal(report.code, 'protected_actor')
  assert.equal(report.configuredSmokeMatchesAcme, true)
  assert.equal(report.signInAttempted, false)
  assert.equal(f.calls.length, 0)
  assert.equal(report.candidateCount, null)
})
test('the documented administrator is also never used as a login', async () => {
  const f = fixture({ env: { SMOKE_OWNER_EMAIL: documentedIdentity } })
  const report = await run(f)
  assert.equal(report.code, 'protected_actor')
  assert.equal(report.configuredSmokeMatchesPolicy, true)
  assert.equal(f.calls.length, 0)
})
test('wrong push context or actual workflow identity is rejected before owner HTTP', async () => {
  for (const options of [{ env: { GITHUB_RUN_ATTEMPT: '2' } }, { env: { GITHUB_EVENT_NAME: 'pull_request' } }, { wrongWorkflow: true }]) {
    const f = fixture(options), report = await run(f)
    assert.ok(['context_rejected', 'driver_context_mismatch'].includes(report.code))
    assert.equal(posts(f).length, 0)
    assert.equal(report.signInAttempted, false)
  }
})
test('zero administrator matches are an inspection result, and a member empty invitation list is not global absence', async () => {
  const f = fixture({ noMatches: true }), report = await run(f)
  assert.equal(report.status, 'inspected')
  assert.ok(report.candidates.every(team => team.documentedPolicy.members === 0 && team.configuredAcme.members === 0))
  assert.ok(report.candidates.every(team => team.invitationsVisibleToActor === false && team.visiblePendingInvitationCount === null))
  assert.equal(report.incomingUnjoinedInvitationsInspected, false)
  clean(report)
})
test('candidate HTTP failure preserves the failure and partial count while normal cleanup still runs', async () => {
  const f = fixture({ candidateHttpFailure: true }), report = await run(f)
  assert.equal(report.status, 'failed')
  assert.equal(report.code, 'http_status_failed')
  assert.equal(report.candidatesRead, 1)
  clean(report)
  assert.equal(posts(f).length, 2)
  assert.equal(JSON.stringify(report).includes('PRIVATE-BODY-CANARY'), false)
})
test('candidate identity or member shape errors never silently become zero matches', async () => {
  for (const options of [{ wrongCandidate: true }, { badMember: true }, { malformedChoice: true }]) {
    const f = fixture(options), report = await run(f)
    assert.equal(report.status, 'failed')
    assert.ok(['candidate_identity', 'candidate_members_invalid'].includes(report.code))
    if (options.malformedChoice) assert.equal(f.calls.some(call => call.url.includes('/workspace?')), false)
    clean(report)
  }
})
test('a different authenticated actor is closed before any workspace read', async () => {
  const f = fixture({ wrongActor: true }), report = await run(f)
  assert.equal(report.code, 'session_identity')
  assert.equal(f.calls.some(call => call.url.includes('/workspace')), false)
  clean(report)
})
test('a changed public build is detected after cleanup and never produces inspected status', async () => {
  const f = fixture({ changedBuild: true }), report = await run(f)
  assert.equal(report.status, 'failed')
  assert.equal(report.code, 'target_changed')
  assert.equal(report.targetUnchanged, false)
  clean(report)
  assert.ok(f.calls.at(-1).url.endsWith('/api/version'))
})
test('failed signout or uncertain signin remains failure and neither POST is retried', async () => {
  const f = fixture({ logoutFails: true }), report = await run(f)
  assert.equal(report.status, 'failed')
  assert.equal(report.cleanupSucceeded, false)
  assert.equal(report.sessionClosed, false)
  assert.equal(posts(f).length, 2)
  const uncertain = fixture({ uncertainSignIn: true }), result = await run(uncertain)
  assert.equal(result.code, 'http_transport_failed')
  assert.equal(result.status, 'failed')
  assert.equal(result.normalSessionObserved, false)
  assert.equal(posts(uncertain).length, 2)
  assert.equal(JSON.stringify(result).includes('PRIVATE-TRANSPORT-CANARY'), false)
})
test('the real CLI refuses arguments without reading credentials or making requests', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mikka-team-inspection-'))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./production-team-membership-inspection.mjs', import.meta.url)), 'unexpected'], {
      cwd, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH },
    })
    assert.equal(result.status, 1)
    const report = JSON.parse(await readFile(join(cwd, 'production-team-membership-inspection-report/report.json'), 'utf8'))
    assert.equal(report.code, 'arguments_rejected')
    assert.equal(report.signInAttempted, false)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
