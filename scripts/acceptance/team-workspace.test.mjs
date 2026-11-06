import assert from 'node:assert/strict'
import test from 'node:test'
import { encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { responseCookieJar } from './read-cache-production.mjs'
import { TeamWorkspaceError, isTeamWorkspaceSwitchRequest, publicTeamWorkspaceFailure, selectTeamWorkspace } from './team-workspace.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const OWNER = 'synthetic-shared-owner'
const PERSONAL = '10000000-0000-4000-8000-000000000010'
const TEAM = '10000000-0000-4000-8000-000000000012'
const SECOND = '10000000-0000-4000-8000-000000000013'
const TEAM_HASH = 'e404ef5072b6edd794d5d188c1aa926142368f5e97f7442f3cca43b8abbe2a45'

function fixture(options = {}) {
  const jar = responseCookieJar(Date.now), requests = []
  jar.receive(new URL(ORIGIN), new Headers({ 'set-cookie': 'session=synthetic-only; Path=/; Secure; HttpOnly' }))
  const json = async (path, body) => {
    const url = new URL(path, ORIGIN), cookie = jar.header(url)
    requests.push({ path, body, cookie })
    assert.equal(url.origin, ORIGIN); assert.equal(url.search, '')
    let response
    if (path === '/mikka/api/workspace') {
      if (options.readError) throw options.readError
      const selected = cookie.includes('mikka-workspace=' + TEAM)
      const choices = [{ id: PERSONAL, kind: 'personal' },
        ...(options.noTeams ? [] : [{ id: TEAM, kind: 'team' }]),
        ...(options.multipleTeams || selected && options.membershipChanged ? [{ id: SECOND, kind: 'team' }] : [])]
      response = Response.json({
        currentUserId: selected && options.ownerChanged ? 'another-user' : OWNER,
        workspace: { id: selected && !options.wrongWorkspace ? TEAM : PERSONAL, kind: selected && !options.wrongWorkspace ? 'team' : 'personal' },
        role: selected ? options.role ?? 'member' : 'admin', choices,
      })
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
  return { requests, run: () => selectTeamWorkspace({ ownerId: OWNER, json }) }
}

test('the normal member or admin selects the unique active team with server cookies and a stable closed report', async () => {
  for (const role of ['member', 'admin']) {
    const f = fixture({ role }), report = await f.run()
    assert.deepEqual(report, { teamWorkspaceConfirmed: true, teamWorkspaceHash: TEAM_HASH,
      teamSelectionBasis: 'unique-active-team-membership', teamOwnerAttribution: 'AGENTS.md-shared-account-team' })
    assert.equal(f.requests[0].cookie.includes('mikka-workspace'), false)
    assert.ok(f.requests[2].cookie.includes('mikka-workspace=' + TEAM))
    assert.equal(JSON.stringify(report).includes(TEAM), false)
    assert.equal(JSON.stringify(report).includes(OWNER), false)
  }
})

test('zero or multiple active teams never choose the first item or send a switch', async () => {
  for (const [options, detail] of [[{ noTeams: true }, 'team_missing'], [{ multipleTeams: true }, 'team_ambiguous']]) {
    const f = fixture(options)
    await assert.rejects(f.run(), error => error instanceof TeamWorkspaceError && error.detail === detail)
    assert.equal(f.requests.some(row => row.body !== undefined), false)
  }
})

test('successful HTTP cannot replace the actual authorized action result or its exact UUID', async () => {
  for (const options of [{ actionError: true }, { wrongSwitch: true }]) {
    const f = fixture(options)
    await assert.rejects(f.run(), error => error.detail === 'switch_response')
    assert.equal(f.requests.some(row => row.path.endsWith('/get-session')), false)
  }
})

test('missing server cookie and changed tenant, membership, or current account remain blocked', async () => {
  for (const options of [{ dropCookie: true }, { wrongWorkspace: true }, { membershipChanged: true }, { ownerChanged: true }, { role: 'viewer' }]) {
    await assert.rejects(fixture(options).run(), error => error.detail === 'workspace_changed')
  }
  await assert.rejects(fixture({ sessionChanged: true }).run(), error => error.detail === 'session_changed')
})

test('transport causes are retained internally while the public failure contains no provider text or account data', async () => {
  const cause = new Error('PRIVATE_RESPONSE ' + OWNER + ' ' + TEAM)
  await assert.rejects(fixture({ readError: cause }).run(), error => {
    assert.equal(error.cause, cause)
    assert.deepEqual(publicTeamWorkspaceFailure(error), { code: 'team_workspace_failed', detail: 'workspace_read' })
    assert.equal(JSON.stringify(publicTeamWorkspaceFailure(error)).includes('PRIVATE'), false)
    return true
  })
})

test('the RPC admission predicate permits only the existing one-UUID same-account switch contract', () => {
  const body = { version: DESKTOP_RPC_VERSION, action: 'workspace.switchWorkspace', args: [TEAM] }
  assert.ok(isTeamWorkspaceSwitchRequest(body))
  for (const changed of [
    null, {}, { ...body, action: 'workspace.createWorkspace' }, { ...body, version: -1 },
    { ...body, args: [{ workspaceId: TEAM, accountId: 'another-user' }] },
    { ...body, args: [TEAM, SECOND] }, { ...body, args: [] }, { ...body, extra: true },
  ]) assert.equal(Boolean(isTeamWorkspaceSwitchRequest(changed)), false)
})


test('a switch response from another wire version cannot confirm the selected team', async () => {
  await assert.rejects(fixture({ wireVersion: 0 }).run(), error => error.detail === 'switch_response')
})
