// Item 11 uses the ordinary browser session, RPC and HTTP routes. Only an
// already-delivered source message is seeded for the non-LLM Factory route.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

export async function verifyWorkspaceGovernance({ accounts, pool, progress, signal, runId, recordSecrets }) {
  const marker = `governance-${runId}`
  const query = async (sql, values = []) => (await pool.query(sql, values)).rows
  const request = async (account, path, body, expected = 200) => {
    signal.throwIfAborted()
    const response = await account.request(path, { signal, ...(body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) })
    const endpoint = /^\/api\/factory\/tasks\/[a-f0-9-]{36}$/.test(path) ? 'factory-detail' : path.startsWith('/api/factory/tasks?') ? 'factory-list' : path === '/api/factory/tasks/route' ? 'factory-route' : 'ordinary-route'
    assert.equal(response.status, expected, `governance HTTP ${body === undefined ? 'GET' : 'POST'} ${endpoint} failed`)
    return response.json()
  }
  const rpc = async (account, action, ...args) => {
    signal.throwIfAborted()
    const response = await account.request('/api/rpc', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' },
      body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action, args: encode(args) }),
    })
    assert.equal(response.status, 200, `governance RPC transport failed: ${action}`)
    const envelope = await response.json()
    assert.equal(envelope.ok, true, `governance RPC envelope failed: ${action}`)
    assert.equal(envelope.version, DESKTOP_RPC_VERSION)
    return decode(envelope.result)
  }
  const workspaceAction = async (account, action, input) => {
    const value = await rpc(account, `workspace.${action}`, input)
    // Error copy and invitation links may contain account data. Assertions
    // retain only stable action names, never response bodies or arguments.
    assert.equal(value?.ok, true, `governance workspace action failed: ${action}`)
    return value.data
  }
  const switchTo = async (account, workspaceId) => {
    assert.equal((await workspaceAction(account, 'switchWorkspace', workspaceId)).workspaceId, workspaceId)
    assert.equal((await request(account, '/api/workspace')).workspace.id, workspaceId, 'selection must survive a new authenticated HTTP request')
  }
  const createTask = async (account, label, workspaceId) => {
    const result = await rpc(account, 'issues.saveIssue', {
      title: `${marker}-${label}`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Workspace governance acceptance' }] }] },
      status: 'todo', priority: 'normal',
    })
    assert.ok(result?.issue?.id, 'ordinary task creation must succeed')
    const [stored] = await query('SELECT "userId","workspaceId","ownershipState" FROM issues WHERE id=$1', [result.issue.id])
    assert.deepEqual(stored, { userId: account.userId, workspaceId, ownershipState: 'bound' }, 'task tenant must come from the selected authenticated workspace')
    return result.issue
  }
  const views = async (account, visible, hidden) => {
    const list = await request(account, '/api/mobile/tasks')
    const search = await request(account, `/api/issues/search?q=${encodeURIComponent(marker)}`)
    for (const issue of visible) {
      assert.ok(list.tasks.some(task => task.id === issue.id), 'selected tenant task missing from list')
      assert.ok(search.items.some(task => task.id === issue.id), 'selected tenant task missing from search')
      assert.equal((await rpc(account, 'issues.getIssue', issue.id)).issue?.id, issue.id, 'selected tenant task missing from detail')
    }
    for (const issue of hidden) {
      assert.ok(!list.tasks.some(task => task.id === issue.id), 'another tenant leaked into list')
      assert.ok(!search.items.some(task => task.id === issue.id), 'another tenant leaked into search')
      assert.equal((await rpc(account, 'issues.getIssue', issue.id)).error, 'issueNotFound', 'another tenant leaked into detail')
    }
  }
  const denyEdit = async (account, issue) => {
    const [before] = await query('SELECT title,status,priority,revision,"workspaceId" FROM issues WHERE id=$1', [issue.id])
    const changed = await rpc(account, 'issues.saveIssue', { id: issue.id, revision: issue.revision, title: `${marker}-forbidden`, content: issue.content, status: 'todo', priority: 'high' })
    assert.equal(changed.error, 'issueNotFound', 'tenant denial must precede mutation')
    const [after] = await query('SELECT title,status,priority,revision,"workspaceId" FROM issues WHERE id=$1', [issue.id])
    assert.deepEqual(after, before, 'denied task edit must have no side effects')
  }
  const factoryState = async taskId => (await query(`SELECT t.revision,t.stage,t.status,
    (SELECT count(*)::int FROM factory_events e WHERE e."taskId"=t.id) AS events,
    (SELECT count(*)::int FROM factory_attempts a WHERE a."taskId"=t.id) AS attempts
    FROM factory_tasks t WHERE t.id=$1`, [taskId]))[0]
  const routeFactory = async (account, issue, workspaceId) => {
    const sourceEventId = randomUUID()
    await accounts.assertActive()
    // Delivered background messages cannot wake a real model. The issue and
    // user came from the real RPC above; Factory still validates the source.
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload,tier,"deliveredAt")
      VALUES ($1::uuid,$2,'user_message',$1::text,$3,$4,'background',now())`, [sourceEventId,account.userId,issue.id,{ text: marker }])
    const body = { issueId: issue.id, sourceEventId, eventId: randomUUID(), rationale: 'Workspace governance acceptance', missingInformation: ['Acceptance intentionally waits for clarification'] }
    const routed = await request(account, '/api/factory/tasks/route', body)
    assert.equal(routed.stage, 'clarify')
    assert.equal(routed.status, 'waiting')
    assert.equal(routed.task.workspaceId, workspaceId)
    const beforeReplay = await factoryState(routed.taskId)
    assert.equal((await request(account, '/api/factory/tasks/route', body)).taskId, routed.taskId)
    assert.deepEqual(await factoryState(routed.taskId), beforeReplay, 'same-tenant replay must not duplicate Factory effects')
    assert.equal((await request(account, `/api/factory/tasks/${routed.taskId}`)).task.id, routed.taskId)
    assert.ok((await request(account, `/api/factory/tasks?issueId=${issue.id}`)).tasks.some(task => task.id === routed.taskId))
    return { ...routed, request: body }
  }
  const denyFactory = async (account, routed) => {
    const selected = (await request(account, '/api/workspace')).workspace.id
    assert.notEqual(selected, routed.task.workspaceId, 'Factory denial must run outside the task workspace')
    const before = await factoryState(routed.taskId)
    for (const path of [`/api/factory/tasks/${routed.taskId}`, `/api/factory/tasks?issueId=${routed.task.issueId}`]) {
      assert.equal((await request(account, path, undefined, 404)).error, 'factoryNotFound')
    }
    assert.equal((await request(account, '/api/factory/tasks/route', routed.request, 404)).error, 'factoryNotFound')
    assert.equal((await request(account, `/api/factory/tasks/${routed.taskId}`, {
      binding: { taskId: routed.taskId, revision: routed.binding.revision }, eventId: randomUUID(), action: 'cancel', reason: 'Forbidden cross-workspace mutation',
    }, 404)).error, 'factoryNotFound')
    assert.deepEqual(await factoryState(routed.taskId), before, 'denied Factory reads/replays/controls must have no side effects')
  }

  const personal = (await request(accounts.owner, '/api/workspace')).choices.find(choice => choice.kind === 'personal')
  assert.ok(personal, 'the leased owner needs an ordinary personal workspace')
  await switchTo(accounts.owner, personal.id)
  const personalTask = await createTask(accounts.owner, 'personal', personal.id)
  const a = await workspaceAction(accounts.owner, 'createWorkspace', { name: `Governance A ${runId.slice(0, 8)}`, slug: `${marker}-a` })
  const taskA = await createTask(accounts.owner, 'shared-a', a.workspaceId)
  const b = await workspaceAction(accounts.owner, 'createWorkspace', { name: `Governance B ${runId.slice(0, 8)}`, slug: `${marker}-b` })
  const taskB = await createTask(accounts.owner, 'shared-b', b.workspaceId)
  await views(accounts.owner, [taskB], [personalTask, taskA])
  await denyEdit(accounts.owner, taskA)
  await switchTo(accounts.owner, personal.id)
  await views(accounts.owner, [personalTask], [taskA, taskB])
  await switchTo(accounts.owner, a.workspaceId)
  await views(accounts.owner, [taskA], [personalTask, taskB])
  await progress('item11-workspace-governance', 'evidence', 'Personal and two shared workspaces: trusted task creation and selected-workspace list/detail/search')

  await views(accounts.peer, [], [personalTask, taskA, taskB])
  const peerSession = await request(accounts.peer, '/api/auth/get-session')
  assert.equal(peerSession.user?.id, accounts.peer.userId)
  assert.equal(typeof peerSession.user.email, 'string')
  const invitations = await workspaceAction(accounts.owner, 'createWorkspaceInvitation', { workspaceId: a.workspaceId, emails: [peerSession.user.email], role: 'member' })
  assert.equal(invitations.length, 1)
  const token = /^\/invite\/([a-f0-9]{64})$/.exec(invitations[0].path)?.[1]
  assert.ok(token, 'the server must issue an ordinary invitation')
  await recordSecrets([token])
  assert.equal((await workspaceAction(accounts.peer, 'acceptWorkspaceInvitation', token)).workspaceId, a.workspaceId)
  const peerTask = await createTask(accounts.peer, 'member-a', a.workspaceId)
  await views(accounts.peer, [taskA, peerTask], [personalTask, taskB])
  assert.equal((await rpc(accounts.peer, 'workspace.switchWorkspace', b.workspaceId)).ok, false, 'membership in A cannot select B')
  await views(accounts.owner, [taskA, peerTask], [personalTask, taskB])

  const factoryA = await routeFactory(accounts.owner, taskA, a.workspaceId)
  const peerFactory = await routeFactory(accounts.peer, peerTask, a.workspaceId)
  await switchTo(accounts.owner, b.workspaceId)
  await denyFactory(accounts.owner, factoryA)
  await switchTo(accounts.owner, a.workspaceId)
  assert.equal((await request(accounts.owner, `/api/factory/tasks/${factoryA.taskId}`)).task.id, factoryA.taskId)
  await progress('item11-workspace-governance', 'evidence', 'Real invitation and acceptance; Factory same-tenant replay succeeds and another selected workspace cannot read or mutate it')

  await workspaceAction(accounts.owner, 'updateWorkspaceMember', { workspaceId: a.workspaceId, userId: accounts.peer.userId, role: 'member', status: 'suspended' })
  await views(accounts.peer, [], [personalTask, taskA, taskB, peerTask])
  await denyEdit(accounts.peer, peerTask)
  await denyFactory(accounts.peer, peerFactory)
  assert.equal((await rpc(accounts.peer, 'workspace.switchWorkspace', a.workspaceId)).ok, false, 'a stale workspace cookie cannot restore suspended membership')
  await views(accounts.owner, [taskA, peerTask], [personalTask, taskB])
  await workspaceAction(accounts.owner, 'updateWorkspaceMember', { workspaceId: a.workspaceId, userId: accounts.peer.userId, role: 'member', status: 'active' })
  await switchTo(accounts.peer, a.workspaceId)
  await views(accounts.peer, [taskA, peerTask], [personalTask, taskB])
  assert.equal((await request(accounts.peer, `/api/factory/tasks/${peerFactory.taskId}`)).task.id, peerFactory.taskId)
  const [runs] = await query('SELECT count(*)::int AS count FROM agent_runs WHERE "issueId"=ANY($1::uuid[])', [[personalTask.id, taskA.id, taskB.id, peerTask.id]])
  assert.equal(runs.count, 0, 'governance acceptance must not dispatch a model or daemon run')
  await progress('item11-workspace-governance', 'evidence', 'Suspension rejects the creator’s task and Factory access without side effects; explicit reactivation restores access; no Agent runs dispatched')
  const { verifyWorkDomain } = await import('./work-domain-acceptance.mjs')
  await verifyWorkDomain({ accounts, pool, rpc, switchTo, a, b, taskA, taskB, peerTask, personalTask, progress, signal, runId })
}
