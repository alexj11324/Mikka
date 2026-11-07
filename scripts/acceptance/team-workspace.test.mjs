import assert from 'node:assert/strict'
import test from 'node:test'
import { encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { responseCookieJar } from './read-cache-production.mjs'
import * as selection from './team-workspace.mjs'

const { TeamWorkspaceError, isTeamWorkspaceSwitchRequest, publicTeamWorkspaceFailure, selectTeamWorkspace } = selection
const ORIGIN = 'https://app.aspectlylabs.com'
const OWNER = 'synthetic-shared-owner'
const ADMIN = 'synthetic-policy-admin'
// Public identity explicitly supplied by the owner, not a login credential:
// https://github.com/alexj11324/Mikka/issues/1504#issuecomment-6691409495
const ADMIN_EMAIL = 'alex@acme.aspectlylabs.com'
const PERSONAL = '10000000-0000-4000-8000-000000000010'
const TEAM = '10000000-0000-4000-8000-000000000012'
const SECOND = '10000000-0000-4000-8000-000000000013'
const THIRD = '10000000-0000-4000-8000-000000000014'
const TEAM_HASH = 'e404ef5072b6edd794d5d188c1aa926142368f5e97f7442f3cca43b8abbe2a45'

function fixture(options = {}) {
  const jar = responseCookieJar(Date.now), requests = []
  jar.receive(new URL(ORIGIN), new Headers({ 'set-cookie': 'session=synthetic-only; Path=/; Secure; HttpOnly' }))
  const choices = () => [{ id: PERSONAL, kind: 'personal' }, ...(options.noTeams ? [] : [
    ...(options.oneTeam ? [] : [{ id: SECOND, kind: 'team' }]), { id: TEAM, kind: 'team' },
    ...(options.duplicateChoice ? [{ id: TEAM, kind: 'team' }] : []),
  ])]
  const members = id => [{
    userId: options.adminIsOwner ? OWNER : ADMIN,
    email: options.noAdmin || id !== TEAM && !options.multipleMatches ? 'other-admin@example.invalid' : options.adminEmail ?? ADMIN_EMAIL,
    role: options.adminRole ?? 'admin', status: options.adminStatus ?? 'active',
  }]
  const json = async (path, body) => {
    const url = new URL(path, ORIGIN), cookie = jar.header(url)
    requests.push({ path, body, cookie })
    assert.equal(url.origin, ORIGIN)
    let response
    if (url.pathname === '/mikka/api/workspace') {
      if (options.readError) throw options.readError
      const queried = url.searchParams.get('workspace')
      if (queried) {
        assert.equal(path, '/mikka/api/workspace?workspace=' + queried)
        assert.ok(choices().some(choice => choice.kind === 'team' && choice.id === queried))
        if (options.candidateErrorFor === queried) throw options.candidateError
        let value = { currentUserId: OWNER, workspace: { id: queried, kind: 'team' },
          role: options.role ?? 'member', choices: choices(), members: members(queried) }
        value = options.changeCandidate?.(value, queried) ?? value
        response = Response.json(value)
      } else {
        assert.equal(url.search, '')
        const selected = cookie.includes('mikka-workspace=' + TEAM)
        const value = {
          currentUserId: selected && options.ownerChanged ? 'another-user' : OWNER,
          workspace: { id: selected && !options.wrongWorkspace ? TEAM : PERSONAL,
            kind: selected && !options.wrongWorkspace ? 'team' : 'personal' },
          role: selected ? options.readbackRole ?? options.role ?? 'member' : 'admin',
          choices: [...choices(), ...(selected && options.membershipChanged ? [{ id: THIRD, kind: 'team' }] : [])],
          members: selected ? members(TEAM) : [],
        }
        if (selected && options.adminChanged) value.members[0].userId = 'another-admin'
        response = Response.json(value)
      }
    } else if (path === '/mikka/api/rpc') {
      assert.deepEqual(body, { version: DESKTOP_RPC_VERSION, action: 'workspace.switchWorkspace', args: [TEAM] })
      const result = options.actionError ? { ok: false, error: 'PRIVATE_ACTION_ERROR' }
        : { ok: true, data: { workspaceId: options.wrongSwitch ? SECOND : TEAM } }
      response = Response.json({ version: options.wireVersion ?? DESKTOP_RPC_VERSION, ok: true, result: encode(result) },
        { headers: options.dropCookie ? {} : { 'set-cookie': 'mikka-workspace=' + TEAM + '; Path=/; Secure; HttpOnly; SameSite=Lax' } })
    } else {
      assert.equal(path, '/mikka/api/auth/get-session')
      response = Response.json({ user: { id: options.sessionChanged ? 'another-user' : OWNER } })
    }
    jar.receive(url, response.headers)
    return response.json()
  }
  return { requests, run: onSelected => selectTeamWorkspace({ ownerId: OWNER, json, onSelected }) }
}

test('the private selection callback runs once only after all team and session fences pass', async () => {
  const f = fixture(), selected = []
  const report = await f.run(value => {
    assert.equal(f.requests.at(-1).path, '/mikka/api/auth/get-session')
    selected.push(value)
  })
  assert.deepEqual(selected, [{ workspaceId: TEAM, adminId: ADMIN }])
  assert.deepEqual(report, await fixture().run())
  for (const options of [{ noTeams: true }, { noAdmin: true }, { multipleMatches: true },
    { dropCookie: true }, { adminChanged: true }, { membershipChanged: true }, { sessionChanged: true }]) {
    let calls = 0
    await assert.rejects(fixture(options).run(() => { calls++ }), TeamWorkspaceError)
    assert.equal(calls, 0)
  }
})

test('multiple active teams select only the unique policy admin match with normal cookies', async () => {
  for (const role of ['member', 'admin']) {
    const f = fixture({ role }), report = await f.run()
    assert.deepEqual(report, { teamWorkspaceConfirmed: true, teamWorkspaceHash: TEAM_HASH,
      teamSelectionBasis: 'unique-active-admin-identity-match',
      teamOwnerAttribution: 'AGENTS.md-and-owner-comment-1504-6691409495', teamAdminMembershipVerified: true })
    assert.deepEqual(f.requests.filter(row => row.path.includes('?')).map(row => row.path),
      [SECOND, TEAM].map(id => '/mikka/api/workspace?workspace=' + id))
    const switchAt = f.requests.findIndex(row => row.body !== undefined)
    assert.equal(switchAt, 3)
    assert.equal(f.requests[switchAt + 1].path, '/mikka/api/workspace')
    assert.ok(f.requests[switchAt + 1].cookie.includes('mikka-workspace=' + TEAM))
    for (const identity of [TEAM, SECOND, OWNER, ADMIN, ADMIN_EMAIL]) assert.equal(JSON.stringify(report).includes(identity), false)
  }
})

test('even one team needs the policy admin identity instead of trusting a sole choice', async () => {
  const f = fixture({ oneTeam: true, noAdmin: true })
  await assert.rejects(f.run(), error => error.detail === 'team_admin_missing')
  assert.equal(f.requests.some(row => row.body !== undefined), false)
  assert.equal((await fixture({ oneTeam: true }).run()).teamAdminMembershipVerified, true)
})

test('zero teams and zero or multiple policy matches fail closed before any switch', async () => {
  for (const [options, detail] of [[{ noTeams: true }, 'team_missing'], [{ noAdmin: true }, 'team_admin_missing'],
    [{ multipleMatches: true }, 'team_admin_ambiguous']]) {
    const f = fixture(options)
    await assert.rejects(f.run(), error => error instanceof TeamWorkspaceError && error.detail === detail)
    assert.equal(f.requests.some(row => row.body !== undefined), false)
    assert.equal(f.requests.filter(row => row.path.includes('?')).length, options.noTeams ? 0 : 2)
  }
})

test('the trusted identity must be another active admin, never a name or an ordinary member', async () => {
  for (const options of [{ adminRole: 'member' }, { adminStatus: 'suspended' }, { adminIsOwner: true }, { noAdmin: true }]) {
    await assert.rejects(fixture(options).run(), error => error.detail === 'team_admin_missing')
  }
  assert.equal((await fixture({ adminEmail: ' ALEX@ACME.ASPECTLYLABS.COM ' }).run()).teamAdminMembershipVerified, true)
})

test('every candidate must return the same account and exact authorized team with a valid member list', async () => {
  const edits = [
    value => ({ ...value, currentUserId: 'another-user' }),
    value => ({ ...value, workspace: { id: THIRD, kind: 'team' } }),
    value => ({ ...value, workspace: { ...value.workspace, kind: 'personal' } }),
    value => ({ ...value, role: 'viewer' }),
    value => ({ ...value, members: null }),
    value => ({ ...value, members: [{ ...value.members[0], email: null }] }),
    value => ({ ...value, members: [value.members[0], value.members[0]] }),
  ]
  for (const changeCandidate of edits) {
    const f = fixture({ changeCandidate })
    await assert.rejects(f.run(), error => error.detail === 'candidate_identity')
    assert.equal(f.requests.some(row => row.body !== undefined), false)
  }
})

test('an unreadable later candidate is never ignored after a matching team was seen', async () => {
  const cause = new Error('PRIVATE_CANDIDATE ' + OWNER + ' ' + TEAM)
  const f = fixture({ multipleMatches: true, candidateErrorFor: TEAM, candidateError: cause })
  await assert.rejects(f.run(), error => {
    assert.equal(error.detail, 'candidate_read'); assert.equal(error.cause, cause)
    assert.deepEqual(publicTeamWorkspaceFailure(error), { code: 'team_workspace_failed', detail: 'candidate_read' })
    return true
  })
  assert.equal(f.requests.some(row => row.body !== undefined), false)
  assert.equal(f.requests.filter(row => row.path.includes('?')).length, 2)
})

test('a successful HTTP response still needs the versioned inner action result and exact UUID', async () => {
  for (const options of [{ actionError: true }, { wrongSwitch: true }, { wireVersion: 0 }]) {
    const f = fixture(options)
    await assert.rejects(f.run(), error => error.detail === 'switch_response')
    assert.equal(f.requests.some(row => row.path.endsWith('/get-session')), false)
  }
})

test('queryless readback still requires the normal cookie and unchanged tenant membership and admin', async () => {
  for (const options of [{ dropCookie: true }, { wrongWorkspace: true }, { membershipChanged: true },
    { ownerChanged: true }, { readbackRole: 'viewer' }, { adminChanged: true }]) {
    await assert.rejects(fixture(options).run(), error => error.detail === 'workspace_changed')
  }
  await assert.rejects(fixture({ sessionChanged: true }).run(), error => error.detail === 'session_changed')
})

test('transport causes stay internal while closed failures contain no account or response data', async () => {
  const cause = new Error('PRIVATE_RESPONSE ' + OWNER + ' ' + TEAM)
  await assert.rejects(fixture({ readError: cause }).run(), error => {
    assert.equal(error.cause, cause)
    assert.deepEqual(publicTeamWorkspaceFailure(error), { code: 'team_workspace_failed', detail: 'workspace_read' })
    assert.equal(JSON.stringify(publicTeamWorkspaceFailure(error)).includes('PRIVATE'), false)
    return true
  })
})

test('candidate IDs must be unique canonical UUIDs from the authorized initial choices', async () => {
  const f = fixture({ duplicateChoice: true })
  await assert.rejects(f.run(), error => error.detail === 'team_identity')
  assert.equal(f.requests.length, 1)
})

test('the read predicate allows only no query or exactly one canonical workspace UUID query', () => {
  assert.equal(selection.isTeamWorkspaceReadPath('/mikka/api/workspace'), true)
  assert.equal(selection.isTeamWorkspaceReadPath('/mikka/api/workspace?workspace=' + TEAM), true)
  for (const path of [null, '', 'https://app.aspectlylabs.com/mikka/api/workspace',
    '/mikka/api/workspace?', '/mikka/api/workspace?workspace=', '/mikka/api/workspace?workspace=' + TEAM + '&other=1',
    '/mikka/api/workspace?workspace=' + TEAM + '&workspace=' + SECOND,
    '/mikka/api/workspace?workspace=' + TEAM + '#x', '/mikka/api/workspace?workspace=' + TEAM + '\n',
    '/mikka/api/workspace?workspace=%31' + TEAM.slice(1), '/mikka/api/workspaces']) {
    assert.equal(selection.isTeamWorkspaceReadPath(path), false)
  }
})

test('the RPC predicate permits only the original one-UUID same-account switch contract', () => {
  const body = { version: DESKTOP_RPC_VERSION, action: 'workspace.switchWorkspace', args: [TEAM] }
  assert.ok(isTeamWorkspaceSwitchRequest(body))
  for (const changed of [
    null, {}, { ...body, action: 'workspace.createWorkspace' }, { ...body, version: -1 },
    { ...body, args: [{ workspaceId: TEAM, accountId: 'another-user' }] },
    { ...body, args: [TEAM, SECOND] }, { ...body, args: [] }, { ...body, args: [TEAM + '\n'] }, { ...body, extra: true },
  ]) assert.equal(Boolean(isTeamWorkspaceSwitchRequest(changed)), false)
})
