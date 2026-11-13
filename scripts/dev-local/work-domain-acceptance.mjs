// Item 11 extension: real session/RPC mutations, with read-only database proofs.
// Repository/environment configuration never dispatches a model or a machine.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

export async function verifyWorkDomain({ accounts, pool, rpc, switchTo, a, b, taskA, taskB, peerTask, personalTask, progress, signal, runId }) {
  const marker = `domain-${runId.slice(0, 12)}`
  const workspaceId = a.workspaceId
  const taskIds = [taskA.id, taskB.id, peerTask.id, personalTask.id]
  const query = async (text, values = []) => (await pool.query(text, values)).rows
  const copy = await Promise.all(['en', 'zh-CN'].map(async locale => JSON.parse(await readFile(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf8')).Errors))
  const evidence = text => progress('item11-workspace-governance', 'evidence', `Work domain: ${text}`)

  // Some actions return an ActionResult; others throw before their action body.
  // A malformed request, unknown RPC, session failure or 5xx is never accepted
  // as a successful permission/lifecycle refusal. Do not print response bodies.
  const denied = async (account, action, args, codes) => {
    signal.throwIfAborted()
    const response = await account.request('/api/rpc', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' },
      body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action, args: encode(args) }),
    })
    const envelope = await response.json()
    assert.equal(envelope.version, DESKTOP_RPC_VERSION, `domain refusal protocol: ${action}`)
    if (response.status !== 200) {
      assert.ok([400, 403, 404].includes(response.status), `domain refusal HTTP status: ${action}`)
      assert.equal(envelope.ok, false, `domain refusal envelope: ${action}`)
      assert.ok(codes.includes(envelope.error?.code), `domain refusal code: ${action}`)
      return
    }
    assert.equal(envelope.ok, true, `domain refusal transport: ${action}`)
    const value = decode(envelope.result)
    assert.ok(value && typeof value.error === 'string', `domain action must refuse: ${action}`)
    assert.notEqual(value.ok, true, `domain refused action cannot report success: ${action}`)
    const expected = new Set(codes.flatMap(code => [code, ...copy.map(messages => messages[code]).filter(Boolean)]))
    assert.ok(expected.has(value.code ?? value.error), `domain refusal action code: ${action}`)
  }
  const successful = async (account, action, ...args) => {
    const value = await rpc(account, action, ...args)
    assert.ok(value && !value.error, `domain action failed: ${action}: ${value?.error ?? 'no result'}`)
    return value
  }
  const mobilePresentationBody = async (account, body, expected = 200) => {
    signal.throwIfAborted()
    // The leased ordinary Cookie client sends no desktop Bearer or browser RPC
    // header. Its fixed local Origin remains part of the account-pool boundary.
    const response = await account.request('/api/mobile/task-presentations', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body,
    })
    assert.equal(response.status, expected, 'mobile presentation HTTP status')
    assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/, 'mobile presentation must remain private and uncached')
    return response.json()
  }
  const mobilePresentation = (account, input, expected = 200) => mobilePresentationBody(account, JSON.stringify(input), expected)
  const projectResult = async (account, action, input) => {
    const value = await successful(account, action, input)
    assert.ok(value.project?.id, `domain project missing: ${action}`)
    return value.project
  }
  const teamResult = async (account, action, input) => {
    const value = await successful(account, action, input)
    assert.equal(value.ok, true, `domain team action failed: ${action}`)
    return value.data
  }
  const project = async id => {
    const rows = await rpc(accounts.owner, 'projects.listWorkspaceProjects', workspaceId)
    const found = rows.find(row => row.id === id)
    assert.ok(found, 'domain project must remain in its Workspace')
    return found
  }
  const task = async (account, id) => {
    const result = await successful(account, 'issues.getIssue', id)
    assert.equal(result.issue?.id, id)
    assert.equal(typeof result.issue.issuedIdentifier, 'string')
    assert.ok(result.issue.issuedIdentifier.length > 0)
    assert.equal(result.issue.identifier, result.issue.issuedIdentifier)
    return result.issue
  }
  const identities = () => query('SELECT id,"workspaceId","issuedIdentifier",scope,status FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])
  const relations = () => query('SELECT "issueId","projectId","workspaceId" FROM workspace_project_tasks WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [taskIds])
  const projectState = id => query('SELECT id,"workspaceId",name,revision,"leadUserId","archivedAt" FROM workspace_projects WHERE id=$1', [id])
  const factoryHistory = () => query(`SELECT t.id,t."issueId",t."workspaceId",t.stage,t.status,t.revision,
    (SELECT count(*)::int FROM factory_events e WHERE e."taskId"=t.id) AS events,
    (SELECT count(*)::int FROM factory_attempts a WHERE a."taskId"=t.id) AS attempts
    FROM factory_tasks t WHERE t."issueId"=ANY($1::uuid[]) ORDER BY t.id`, [taskIds])
  const noRuns = async () => {
    const [result] = await query('SELECT count(*)::int AS count FROM agent_runs WHERE "issueId"=ANY($1::uuid[])', [taskIds])
    assert.equal(result.count, 0, 'domain configuration acceptance must not dispatch a Run')
  }
  await accounts.assertActive()
  await switchTo(accounts.owner, workspaceId)
  await switchTo(accounts.peer, workspaceId)
  await task(accounts.owner, taskA.id)
  await task(accounts.peer, peerTask.id)
  const originalIdentities = await identities(), originalFactory = await factoryHistory()
  assert.equal(originalIdentities.length, 4)
  assert.ok(originalIdentities.every(row => typeof row.issuedIdentifier === 'string' && row.issuedIdentifier.length > 0))
  assert.notEqual(originalIdentities.find(row => row.id === taskA.id).issuedIdentifier, originalIdentities.find(row => row.id === peerTask.id).issuedIdentifier)
  await noRuns()

  const sameName = `${marker} same name`
  const draft = { workspaceId, name: sameName, summary: '', description: '', status: 'planned', priority: 'normal', lead: '',
    leadUserId: accounts.peer.userId, memberIds: [accounts.owner.userId, accounts.peer.userId], team: '', startDate: '', targetDate: '',
    properties: { color: 'green', members: [], labels: [], dependencyIds: [], milestones: [{ id: randomUUID(), name: 'Retained milestone', targetDate: '', completed: false }] } }
  let first = await projectResult(accounts.owner, 'projects.saveProject', draft)
  let second = await projectResult(accounts.peer, 'projects.saveProject', { ...draft, leadUserId: accounts.owner.userId })
  assert.notEqual(first.id, second.id, 'equal names must not identify Projects')
  assert.equal(first.createdBy, accounts.owner.userId)
  assert.equal(second.createdBy, accounts.peer.userId)
  for (const account of [accounts.owner, accounts.peer]) {
    const visible = (await rpc(account, 'projects.listWorkspaceProjects', workspaceId)).filter(row => row.name === sameName)
    assert.deepEqual(visible.map(row => row.id).sort(), [first.id, second.id].sort())
  }
  assert.equal(first.leadUserId, accounts.peer.userId)
  assert.deepEqual([...first.memberIds].sort(), [accounts.owner.userId, accounts.peer.userId].sort())
  first = await projectResult(accounts.peer, 'projects.setProjectIssues', { id: first.id, workspaceId, revision: first.revision, issueIds: [taskA.id] })
  second = await projectResult(accounts.owner, 'projects.setProjectIssues', { id: second.id, workspaceId, revision: second.revision, issueIds: [peerTask.id] })
  assert.equal((await task(accounts.peer, taskA.id)).projectId, first.id)
  assert.equal((await task(accounts.owner, peerTask.id)).projectId, second.id)
  first = await projectResult(accounts.peer, 'projects.updateProjectProperties', { id: first.id, workspaceId, revision: first.revision, changes: { name: `${marker} renamed` } })
  assert.equal(first.leadUserId, accounts.peer.userId)
  assert.deepEqual([...first.memberIds].sort(), [accounts.owner.userId, accounts.peer.userId].sort())
  assert.deepEqual(first.properties.milestones, draft.properties.milestones)
  assert.equal((await task(accounts.peer, taskA.id)).metadata.project, first.name)
  assert.equal((await task(accounts.peer, peerTask.id)).metadata.project, sameName, 'renaming one same-name Project cannot change another')
  const peerBeforeMove = await task(accounts.peer, peerTask.id)
  const moved = await successful(accounts.peer, 'projects.moveIssueToProject', { issueId: peerTask.id, revision: peerBeforeMove.revision, projectId: first.id, workspaceId })
  assert.equal(moved.issue?.projectId, first.id)
  assert.equal(moved.issue?.issuedIdentifier, peerBeforeMove.issuedIdentifier)
  first = await project(first.id); second = await project(second.id)
  assert.deepEqual([...first.issueIds].sort(), [taskA.id, peerTask.id].sort())
  assert.deepEqual(second.issueIds, [])
  const bound = await relations()
  assert.deepEqual(bound.map(row => row.projectId), [first.id, first.id])
  assert.ok(bound.every(row => row.workspaceId === workspaceId))
  await denied(accounts.owner, 'projects.setProjectIssues', [{ id: second.id, workspaceId, revision: second.revision, issueIds: [taskA.id] }], ['projectIssueAlreadyLinked'])
  assert.deepEqual(await relations(), bound)

  await switchTo(accounts.owner, b.workspaceId)
  assert.ok(!(await rpc(accounts.owner, 'projects.listProjects')).some(row => [first.id, second.id].includes(row.id)))
  const beforeForeign = await projectState(first.id)
  await denied(accounts.owner, 'projects.updateProjectProperties', [{ id: first.id, revision: first.revision, changes: { name: `${marker} forbidden` } }], ['projectNotFound'])
  await denied(accounts.peer, 'projects.listWorkspaceProjects', [b.workspaceId], ['workspaceAccessDenied'])
  await denied(accounts.peer, 'project-resources.listProjectResources', [b.workspaceId, first.id], ['workspaceAccessDenied'])
  await denied(accounts.peer, 'projects.setProjectIssues', [{ id: first.id, workspaceId, revision: first.revision, issueIds: [taskB.id] }], ['issueNotFound'])
  assert.deepEqual(await projectState(first.id), beforeForeign)
  assert.deepEqual(await relations(), bound)
  await switchTo(accounts.owner, workspaceId)
  await denied(accounts.owner, 'projects.setProjectIssues', [{ id: first.id, workspaceId, revision: first.revision, issueIds: [personalTask.id] }], ['issueNotFound'])
  assert.deepEqual(await relations(), bound)
  await evidence('same-name Projects retain separate UUIDs; shared members edit stable lead/member IDs; Task moves and Project rename use canonical IDs; foreign and personal Task attachment is refused without writes')

  const resourceRead = () => rpc(accounts.owner, 'project-resources.listProjectResources', workspaceId, first.id)
  const initialResources = await resourceRead()
  assert.deepEqual(initialResources.repositories, [])
  assert.deepEqual(initialResources.environmentBindings, [])
  assert.equal(initialResources.policy.mode, 'inherit')
  const emptyResources = { workspaceId, projectId: first.id, revision: first.revision, repositories: [], environmentIds: [], defaultEnvironmentId: null }
  const emptySaved = await successful(accounts.owner, 'project-resources.saveProjectResources', emptyResources)
  assert.equal(emptySaved.revision, first.revision + 1)
  const repoA = `v2/github.com/mikka-acceptance/${marker}-a`, repoB = `v2/github.com/mikka-acceptance/${marker}-b`
  const config = { runtime: 'any', harness: 'any', variables: { DOMAIN_ACCEPTANCE: 'configured' }, secretIds: [], repositoryKeys: [repoA, repoB] }
  const environment = await successful(accounts.owner, 'project-resources.saveEnvironment', { workspaceId, name: `${marker} default`, configuration: config })
  const alternate = await successful(accounts.owner, 'project-resources.saveEnvironment', { workspaceId, name: `${marker} secondary`, configuration: { ...config, variables: { DOMAIN_ACCEPTANCE: 'secondary' } } })
  await denied(accounts.peer, 'project-resources.saveEnvironment', [{ workspaceId, name: `${marker} unauthorized`, configuration: {} }], ['workspaceAccessDenied'])
  await switchTo(accounts.owner, b.workspaceId)
  const foreignEnvironment = await successful(accounts.owner, 'project-resources.saveEnvironment', { workspaceId: b.workspaceId, name: `${marker} foreign`, configuration: {} })
  await switchTo(accounts.owner, workspaceId)
  const beforeForeignBinding = await resourceRead()
  await denied(accounts.owner, 'project-resources.saveProjectResources', [{ ...emptyResources, revision: emptySaved.revision, environmentIds: [foreignEnvironment.id], defaultEnvironmentId: foreignEnvironment.id }], ['projectEnvironmentUnavailable'])
  assert.deepEqual(await resourceRead(), beforeForeignBinding)
  const restricted = await successful(accounts.owner, 'project-resources.saveWorkspaceRepositoryPolicy', { workspaceId, revision: 0, mode: 'restricted', repositoryKeys: [repoA] })
  assert.equal(restricted.revision, 1)
  const configured = { workspaceId, projectId: first.id, revision: emptySaved.revision,
    repositories: [{ repositoryKey: repoA, baseBranch: 'main', environmentId: environment.id, isPrimary: true }, { repositoryKey: repoB, baseBranch: 'develop', environmentId: alternate.id, isPrimary: false }],
    environmentIds: [environment.id, alternate.id], defaultEnvironmentId: environment.id }
  await successful(accounts.owner, 'project-resources.saveProjectResources', configured)
  const storedResources = await resourceRead()
  assert.deepEqual(storedResources.repositories.map(row => row.repositoryKey).sort(), [repoA, repoB].sort())
  assert.deepEqual(storedResources.environmentBindings.map(row => row.environmentId).sort(), [environment.id, alternate.id].sort())
  assert.equal(storedResources.environmentBindings.find(row => row.isDefault)?.environmentId, environment.id)
  assert.equal(storedResources.repositories.find(row => row.isPrimary)?.repositoryKey, repoA)
  assert.deepEqual(storedResources.policy.repositoryKeys, [repoA], 'Workspace policy remains independent from configured Project bindings')
  await denied(accounts.owner, 'project-resources.saveProjectResources', [configured], ['projectResourceConflict'])
  await denied(accounts.peer, 'project-resources.saveWorkspaceRepositoryPolicy', [{ workspaceId, revision: 1, mode: 'inherit', repositoryKeys: [] }], ['workspaceAccessDenied'])
  assert.deepEqual(await resourceRead(), storedResources)
  await successful(accounts.owner, 'project-resources.saveWorkspaceRepositoryPolicy', { workspaceId, revision: 1, mode: 'inherit', repositoryKeys: [] })
  first = await project(first.id)
  await noRuns()
  await evidence('zero and multiple repository/environment bindings persist through real RPC; Workspace policy stays separate; member writes, foreign Environment references and stale revisions are refused; no execution requested')

  const suffix = runId.replace(/[^a-z0-9]/gi, '').slice(0, 7).toUpperCase()
  let team = await teamResult(accounts.owner, 'teams.saveTeam', { workspaceId, name: `${marker} grouping`, identifier: `D${suffix}`, description: '' })
  await teamResult(accounts.owner, 'team-relations.setIssueTeam', { issueId: taskA.id, teamId: team.id, expectedTeamId: null })
  first = await teamResult(accounts.owner, 'team-relations.setProjectTeams', { projectId: first.id, revision: first.revision, teamIds: [team.id], primaryTeamId: team.id })
  await denied(accounts.peer, 'teams.archiveTeam', [team.id], ['workspaceAccessDenied'])
  const impact = await successful(accounts.owner, 'teams.getTeamLifecycleImpact', team.id)
  assert.equal(impact.tasks, 1); assert.equal(impact.projects, 1); assert.equal(impact.canDelete, false)
  const archivedTeam = await successful(accounts.owner, 'teams.archiveTeam', team.id)
  assert.ok(archivedTeam.archivedAt)
  assert.ok(!(await rpc(accounts.owner, 'teams.listTeams')).some(row => row.id === team.id))
  assert.ok((await rpc(accounts.owner, 'teams.loadTeamDirectory', workspaceId)).teams.find(row => row.id === team.id)?.archivedAt)
  await denied(accounts.owner, 'team-relations.setIssueTeam', [{ issueId: peerTask.id, teamId: team.id, expectedTeamId: null }], ['teamArchived'])
  assert.equal((await task(accounts.peer, taskA.id)).projectId, first.id)
  assert.deepEqual(await identities(), originalIdentities)
  assert.equal((await successful(accounts.owner, 'teams.restoreTeam', team.id)).archivedAt, null)
  await teamResult(accounts.owner, 'team-relations.setIssueTeam', { issueId: peerTask.id, teamId: team.id, expectedTeamId: null })
  team = await teamResult(accounts.owner, 'teams.saveTeam', { id: team.id, workspaceId, name: `${marker} renamed grouping`, identifier: `E${suffix}`, description: '' })
  assert.deepEqual(await identities(), originalIdentities)
  const aliases = await query('SELECT "issueId",identifier FROM mikka_task_identifier_aliases WHERE "issueId"=ANY($1::uuid[]) AND "workspaceId"=$2 ORDER BY "issueId",identifier', [[taskA.id, peerTask.id], workspaceId])
  assert.ok(aliases.length >= 2, 'published Team identifiers must have durable history')
  const removed = await successful(accounts.owner, 'teams.removeTeamGrouping', team.id, team.name)
  assert.equal(removed.removed?.teamId, team.id)
  assert.equal(removed.removed.tasks, 2); assert.equal(removed.removed.projects, 1)
  for (const issue of [taskA, peerTask]) {
    assert.equal(await rpc(accounts.owner, 'team-relations.getIssueTeam', issue.id), null)
    assert.equal((await task(accounts.peer, issue.id)).projectId, first.id)
  }
  assert.deepEqual(await relations(), bound)
  assert.deepEqual(await identities(), originalIdentities)
  assert.deepEqual(await query('SELECT "issueId",identifier FROM mikka_task_identifier_aliases WHERE "issueId"=ANY($1::uuid[]) AND "workspaceId"=$2 ORDER BY "issueId",identifier', [[taskA.id, peerTask.id], workspaceId]), aliases)
  const teamJournal = await rpc(accounts.owner, 'teams.getTeamLifecycleAudit', workspaceId, team.id)
  assert.ok(Array.isArray(teamJournal))
  for (const action of ['archived', 'restored', 'grouping_removed']) assert.ok(teamJournal.some(event => event.action === action))
  await evidence('Team archive blocks new grouping, restore allows it, rename preserves issued Task IDs, and explicit grouping removal retains Tasks, Project relations, identifier aliases and lifecycle audit')

  first = await project(first.id)
  const beforeArchive = first
  const historyBefore = await rpc(accounts.peer, 'projects.listProjectEvents', first.id, workspaceId)
  const resourcesBeforeArchive = await resourceRead()
  const projectImpact = await rpc(accounts.owner, 'projects.getProjectLifecycleImpact', { id: first.id, workspaceId })
  assert.equal(projectImpact.counts.tasks, 2)
  assert.equal(projectImpact.counts.teams, 0)
  assert.equal(projectImpact.counts.repositories, 2)
  assert.equal(projectImpact.counts.environments, 2)
  assert.equal(projectImpact.counts.factoryTasks, originalFactory.length)
  assert.equal(projectImpact.canDelete, false)
  first = await projectResult(accounts.peer, 'projects.archiveProject', { id: first.id, workspaceId, revision: first.revision })
  assert.ok(first.archivedAt)
  assert.equal(first.status, beforeArchive.status)
  assert.deepEqual(first.issueIds, beforeArchive.issueIds)
  assert.deepEqual(first.properties, beforeArchive.properties)
  const archivedState = await projectState(first.id)
  await denied(accounts.owner, 'projects.updateProjectProperties', [{ id: first.id, workspaceId, revision: first.revision, changes: { name: `${marker} forbidden archive edit` } }], ['projectArchived'])
  await denied(accounts.owner, 'project-resources.saveProjectResources', [{ ...configured, revision: first.revision }], ['projectArchived'])
  await denied(accounts.owner, 'projects.deleteProject', [{ id: first.id, workspaceId, revision: first.revision, confirmation: first.name }], ['projectDeleteNotEmpty'])
  assert.deepEqual(await projectState(first.id), archivedState)
  assert.deepEqual(await resourceRead(), resourcesBeforeArchive)
  assert.deepEqual(await relations(), bound)
  assert.deepEqual(await identities(), originalIdentities)
  first = await projectResult(accounts.peer, 'projects.restoreProject', { id: first.id, workspaceId, revision: first.revision })
  assert.equal(first.archivedAt, null)
  assert.equal(first.status, beforeArchive.status)
  assert.deepEqual(first.issueIds, beforeArchive.issueIds)
  const historyAfter = await rpc(accounts.peer, 'projects.listProjectEvents', first.id, workspaceId)
  assert.equal(historyAfter.length, historyBefore.length + 2)
  assert.ok(historyBefore.every(event => historyAfter.some(row => row.id === event.id)))
  assert.equal((await task(accounts.owner, taskA.id)).projectId, first.id)
  await evidence('Project impact includes Tasks and Factory history; archive rejects edits/configuration/hard delete, restore retains status, canonical relations, resources, prior events and stable Task identities')

  for (const [account, issue] of [[accounts.owner, taskA], [accounts.peer, peerTask]]) {
    const view = await rpc(account, 'task-domain.getTaskPresentation', issue.id)
    const cards = await rpc(account, 'task-domain.getTaskPresentations', { workspaceId, issueIds: [issue.id], includeInboxReason: true })
    assert.deepEqual(cards.items[issue.id], { ...view, inboxReason: 'needsReply' })
    assert.deepEqual(view, { version: 1, primaryStatus: 'todo', factoryStage: 'triage', runStatus: null, needsAction: 'question', blockedReason: null, completion: null,
      state: 'waiting', reason: 'needs_input', blockedBy: null, group: 'pending' })
  }
  const sharedView = await rpc(accounts.peer, 'task-domain.getTaskPresentation', taskA.id)
  assert.equal(sharedView.primaryStatus, 'todo')
  assert.equal(sharedView.factoryStage, null, 'shared Task access cannot reveal another owner’s Factory execution')
  assert.equal(sharedView.runStatus, null)
  assert.equal(sharedView.completion, null)
  assert.deepEqual([sharedView.state, sharedView.reason, sharedView.blockedBy, sharedView.group], ['todo', null, null, 'todo'])
  await denied(accounts.peer, 'task-domain.getTaskPresentation', [taskB.id], ['issueNotFound', 'workspaceAccessDenied'])
  const wanted = [taskA.id, peerTask.id, taskB.id, personalTask.id, randomUUID(), taskA.id]
  for (const account of [accounts.owner, accounts.peer]) {
    const batch = await rpc(account, 'task-domain.getTaskPresentations', { workspaceId, issueIds: wanted })
    assert.equal(batch.version, 1)
    assert.equal(batch.workspaceId, workspaceId)
    assert.deepEqual(Object.keys(batch.items).sort(), [taskA.id, peerTask.id].sort(), 'batch omits foreign, personal, missing and duplicate Task IDs')
    for (const id of [taskA.id, peerTask.id]) {
      assert.deepEqual(batch.items[id], await rpc(account, 'task-domain.getTaskPresentation', id), 'batch and detail use the same authorized projection')
    }
    assert.deepEqual(await rpc(account, 'task-domain.getTaskPresentations', { workspaceId, issueIds: [] }), { version: 1, workspaceId, items: {} })
    assert.deepEqual(await mobilePresentation(account, { workspaceId, issueIds: wanted }), batch, 'ordinary mobile Cookie transport must preserve the same authorized batch')
    assert.deepEqual(await mobilePresentation(account, { workspaceId, issueIds: [] }), { version: 1, workspaceId, items: {} })
  }
  await denied(accounts.peer, 'task-domain.getTaskPresentations', [{ workspaceId: b.workspaceId, issueIds: [taskB.id] }], ['workspaceAccessDenied'])
  await denied(accounts.peer, 'task-domain.getTaskPresentations', [{ workspaceId: b.workspaceId, issueIds: [] }], ['workspaceAccessDenied'])
  for (const account of [accounts.owner, accounts.peer]) {
    for (const issueIds of [[taskB.id], []]) {
      assert.equal((await mobilePresentation(account, { workspaceId: b.workspaceId, issueIds }, 403)).error, 'workspaceAccessDenied')
    }
  }
  const maximumBatch = [taskA.id, peerTask.id, ...Array.from({ length: 198 }, () => randomUUID())]
  assert.deepEqual(Object.keys((await mobilePresentation(accounts.peer, { workspaceId, issueIds: maximumBatch })).items).sort(), [taskA.id, peerTask.id].sort())
  for (const input of [
    { workspaceId, issueIds: [...maximumBatch, randomUUID()] },
    { workspaceId, issueIds: [taskA.id], userId: accounts.owner.userId },
    { workspaceId, issueIds: ['invalid'] },
  ]) assert.equal((await mobilePresentation(accounts.peer, input, 400)).error, 'invalidRequest')
  assert.equal((await mobilePresentationBody(accounts.peer, '{', 400)).error, 'invalidRequest')
  assert.equal((await mobilePresentationBody(accounts.peer, ' '.repeat(16_385), 413)).error, 'bodyTooLarge')

  const membership = async status => {
    const changed = await rpc(accounts.owner, 'workspace.updateWorkspaceMember', {
      workspaceId, userId: accounts.peer.userId, role: 'member', status,
    })
    assert.equal(changed.ok, true, 'mobile presentation membership change must use the ordinary administrator action')
  }
  await membership('suspended')
  try {
    for (const issueIds of [[taskA.id, peerTask.id], []]) {
      assert.equal((await mobilePresentation(accounts.peer, { workspaceId, issueIds }, 403)).error, 'workspaceAccessDenied')
    }
  } finally {
    await membership('active')
    await switchTo(accounts.peer, workspaceId)
  }
  assert.deepEqual(Object.keys((await mobilePresentation(accounts.peer, { workspaceId, issueIds: [taskA.id, peerTask.id] })).items).sort(), [taskA.id, peerTask.id].sort())
  assert.deepEqual(await factoryHistory(), originalFactory, 'Project and Team lifecycle must preserve Factory history')
  assert.deepEqual(await identities(), originalIdentities)
  await noRuns()
  await evidence('task-domain detail and one batch report the same business/Factory/Run state; batches omit foreign/missing Tasks and duplicate IDs, empty batches still enforce membership, and Shared Task access cannot reveal another owner’s Factory; all original history remains unchanged')
  await evidence('mobile Cookie HTTP returns the identical authorized batch with private/no-store; 200 IDs work, 201 IDs/forged authority/malformed input/oversized bodies are rejected; current Workspace and fresh membership also govern empty batches, and explicit reactivation restores access without creating Runs')
}
