import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { recordAuthenticationSecrets } from '../../../scripts/test-accounts/session.mjs'
import { TestAccountError } from '../../../scripts/test-accounts/pool.mjs'
import { captureParityReadReceipts, parityBotReadKeys } from './parity-reads.mjs'
import { captureParityReaderDefaults } from './parity-reader-defaults.mjs'

const quote = value => `"${value.replaceAll('"', '""')}"`

/** Real application rows, confined to a leased pair and freshly reserved IDs.
 * No provider, auth, RPC or UI response is simulated. The disabled device and
 * ended run never dispatch work or spend model/provider credits. */
export async function createParityFixtures(scope, { epoch = process.env.MIKKA_DESKTOP_FIXTURE_EPOCH ?? `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`, includePeerCoordinator = false } = {}) {
  await scope.assertActive()
  // Threads deliberately have a 30-day list window. Keep the same explicit
  // recent UTC day in paired captures, and record it with the evidence.
  const at = Date.parse(epoch)
  if (!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(epoch) || !Number.isFinite(at) || at > Date.now() || at <= Date.now() - 30 * 86_400_000) throw new TestAccountError('PARITY_FIXTURE_EPOCH_INVALID')
  const AT = epoch
  const ids = Object.fromEntries(['workspace', 'team', 'coordinator', ...(includePeerCoordinator ? ['peerCoordinator'] : []), 'bot', 'issue', 'version', 'device', 'agent', 'run', 'chunk', 'group', 'groupMessage', 'markdown', 'markdownVersion', 'markdownShare', 'html', 'htmlVersion', 'htmlShare', 'coordinatorUser', 'coordinatorReply', 'botUser', 'botReply'].map(key => [key, randomUUID()]))
  const coordinatorIds = [ids.coordinator, ...(includePeerCoordinator ? [ids.peerCoordinator] : [])]
  const fixture = {
    ...ids, epoch, workspaceName: 'Desktop acceptance', teamName: 'Application', botName: 'Ada', groupName: 'Release review',
    issueTitle: 'Review the desktop workspace', issueIdentifier: 'APP-1', agentLabel: 'Codex', artifactTitle: 'Desktop review notes', htmlTitle: 'Desktop review preview',
    // The address is visible in Settings. Independent baseline/candidate
    // databases need the same display text; fresh UUIDs still own every row.
    workspaceSlug: 'desktop-review',
    markdownToken: `mks_${randomBytes(24).toString('base64url')}`, htmlToken: `mks_${randomBytes(24).toString('base64url')}`,
  }
  const resources = [
    ['workspaces', ids.workspace], ['workspace_members', ids.workspace],
    ['teams', ids.team], ['team_members', ids.team], ['team_issues', ids.issue],
    ['bots', ids.coordinator], ['bots', ids.bot], ['coordinator_bots', ids.coordinator],
    ['coordinator_sessions', ids.coordinator], ['coordinator_sessions', ids.bot],
    ...(includePeerCoordinator ? [
      ['bots', ids.peerCoordinator, scope.peer.userId], ['coordinator_bots', ids.peerCoordinator, scope.peer.userId],
      ['coordinator_sessions', ids.peerCoordinator, scope.peer.userId],
    ] : []),
    ['issues', ids.issue], ['issue_versions', ids.version], ['devices', ids.device], ['agents', ids.agent],
    ['agent_runs', ids.run], ['run_chunks', ids.chunk],
    ['conversations', ids.group], ['conversation_members', ids.group], ['conversation_messages', ids.groupMessage],
    ['artifacts', ids.markdown], ['artifact_versions', ids.markdownVersion], ['artifacts', ids.html], ['artifact_versions', ids.htmlVersion],
    ['artifact_shares', ids.markdownShare], ['artifact_shares', ids.htmlShare],
    ...[ids.coordinatorUser, ids.coordinatorReply, ids.botUser, ids.botReply].map(id => ['coordinator_messages', id]),
    ...parityBotReadKeys(ids).map(id => ['conversation_reads', id]),
  ]
  // Reservation uses the pool's owner, environment, generation and absence
  // checks. A failed insertion still leaves a cleanup record for every ID.
  for (const [type, id, ownerId = scope.owner.userId] of resources) await scope.recordResource({ type, id, ownerId })
  await recordAuthenticationSecrets([fixture.markdownToken, fixture.htmlToken], { environment: scope.pool.environment })
  const content = {
    type: 'doc', attrs: { mikka: { assignee: null, project: null, labels: [], pullRequests: [], parentId: null, blockedByIds: [], relatedIds: [], duplicateOfId: null, dueDate: null, estimate: null, favoriteUserIds: [], subscriberUserIds: [scope.owner.userId], deletedAt: null } },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review conversations, task details, artifacts and workspace settings in the desktop app.' }] }],
  }
  const markdown = '# Desktop review\n\nThe workspace shares its components with the web application.\n\n- Conversations and task details\n- Artifacts and workspace settings\n\n## Result\n\nReady for review.\n'
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Desktop review</title><style>body{font:16px system-ui;margin:32px;color:#202020;background:#fff}h1{font-size:28px}li{margin-block:12px}</style></head><body><h1>Desktop review</h1><p>A local artifact preview.</p><ul><li>Conversations</li><li>Task details</li><li>Workspace settings</li></ul></body></html>'
  async function transaction(work) {
    await scope.assertActive()
    return scope.pool.transaction(async client => {
      await scope.pool.current(client, scope.lease)
      const value = await work(client)
      await scope.pool.current(client, scope.lease)
      return value
    })
  }
  async function insert(client, table, row) {
    const entries = Object.entries(row)
    try {
      await client.query(`INSERT INTO public.${quote(table)} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(',')})`, entries.map(([, value]) => value))
    } catch (error) {
      // The table and SQLSTATE identify a fixture/schema mismatch without
      // propagating driver details or any row's private parameters.
      const code = typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'UNKNOWN'
      throw new TestAccountError(`PARITY_FIXTURE_INSERT_${table}_${code}`)
    }
  }
  let cleanupReads
  let cleanupDefaults
  async function cleanup() {
    // Each predicate is a fresh fixture identifier reserved above. Existing
    // user/account rows and personal workspaces are never cleanup targets.
    await transaction(async client => {
      const remove = (table, key, values) => client.query(`DELETE FROM public.${quote(table)} WHERE ${quote(key)}::text = ANY($1::text[])`, [values])
      await cleanupReads?.(client)
      await cleanupDefaults?.(client)
      for (const [table, key, values] of [
        ['conversation_messages', 'conversationId', [ids.group]], ['conversation_members', 'conversationId', [ids.group]], ['conversations', 'id', [ids.group]],
        ['artifact_shares', 'id', [ids.markdownShare, ids.htmlShare]], ['artifact_versions', 'artifactId', [ids.markdown, ids.html]], ['artifacts', 'id', [ids.markdown, ids.html]],
        ['run_chunks', 'runId', [ids.run]], ['agent_runs', 'id', [ids.run]], ['agents', 'id', [ids.agent]], ['devices', 'id', [ids.device]],
        ['issue_versions', 'issueId', [ids.issue]], ['issue_documents', 'issueId', [ids.issue]], ['mikka_team_issues', 'issueId', [ids.issue]], ['issues', 'id', [ids.issue]],
        ['coordinator_messages', 'botId', [...coordinatorIds, ids.bot]], ['coordinator_sessions', 'botId', [...coordinatorIds, ids.bot]],
        ['coordinator_bots', 'botId', coordinatorIds], ['bots', 'id', [...coordinatorIds, ids.bot]],
        ['mikka_team_members', 'teamId', [ids.team]], ['mikka_teams', 'id', [ids.team]],
        ['mikka_workspace_members', 'workspaceId', [ids.workspace]], ['mikka_workspaces', 'id', [ids.workspace]],
      ]) await remove(table, key, values)
    })
    for (const [type, id] of resources) await scope.markResourceCleaned({ type, id })
  }
  try {
    await transaction(async client => {
      const owner = scope.owner.userId
      cleanupReads = await captureParityReadReceipts(client, owner, ids)
      cleanupDefaults = await captureParityReaderDefaults(client, owner)
      const users = (await client.query('SELECT id,name,email FROM public."user" WHERE id=ANY($1::text[])', [[owner, scope.peer.userId]])).rows
      if (users.length !== 2) throw new Error('PARITY_LEASE_USERS_MISSING')
      // The real board defaults to Assignee=Me. Its task must be assigned to
      // this leased member; merely creating an unassigned task is not "Me".
      const assignee = users.find(user => user.id === owner)
      content.attrs.mikka.assignee = { kind: 'member', id: owner, name: assignee.name, image: null }
      fixture.dynamicIdentityEmails = users.map(user => user.email)
      await insert(client, 'mikka_workspaces', { id: ids.workspace, userId: owner, name: fixture.workspaceName, slug: fixture.workspaceSlug, kind: 'team', createdAt: AT })
      for (const user of users) await insert(client, 'mikka_workspace_members', { workspaceId: ids.workspace, userId: user.id, name: user.name, email: user.email, role: user.id === owner ? 'admin' : 'member', status: 'active', createdAt: AT })
      await insert(client, 'mikka_teams', { id: ids.team, workspaceId: ids.workspace, userId: owner, name: fixture.teamName, identifier: 'APP', description: 'Desktop application review', createdAt: AT, updatedAt: AT })
      for (const user of users) await insert(client, 'mikka_team_members', { teamId: ids.team, userId: user.id, role: user.id === owner ? 'owner' : 'member', createdAt: AT })
      for (const [id, name, color, role] of [[ids.coordinator, 'Coordinator', 'encre', ''], [ids.bot, fixture.botName, 'turquoise', 'Reviews application changes and reports results.']]) {
        await insert(client, 'bots', { id, ownerId: owner, workspaceId: ids.workspace, name, color, shape: 'cercle', publicRole: role, createdAt: AT, updatedAt: AT })
      }
      await insert(client, 'coordinator_bots', { ownerId: owner, workspaceId: ids.workspace, botId: ids.coordinator, createdAt: AT })
      // The multi-account lifecycle enters this team as both leased members.
      // Its normal reads need a separately owned Coordinator for each member;
      // reserve the peer's ID before insertion instead of adopting a later row.
      // Ordinary parity fixtures retain their existing owner-only bot list.
      if (includePeerCoordinator) {
        await insert(client, 'bots', { id: ids.peerCoordinator, ownerId: scope.peer.userId, workspaceId: ids.workspace, name: 'Coordinator', color: 'encre', shape: 'cercle', publicRole: '', createdAt: AT, updatedAt: AT })
        await insert(client, 'coordinator_bots', { ownerId: scope.peer.userId, workspaceId: ids.workspace, botId: ids.peerCoordinator, createdAt: AT })
      }
      // Every application row uses the same freshly reserved, leased Team
      // workspace created above; legacy display scope is not tenant evidence.
      await insert(client, 'issues', { id: ids.issue, userId: owner, workspaceId: ids.workspace, ownershipState: 'bound', title: fixture.issueTitle, content: JSON.stringify(content), status: 'todo', priority: 'normal', scope: 'workspace', scopeSetBy: 'user', linearSyncBlocked: true, createdAt: AT, updatedAt: AT })
      // APP issues the stable Workspace identifier in the INSERT transaction.
      // Adding the APP Team below records a historical alias, not a renumbering.
      const identities = (await client.query('SELECT id,"userId","workspaceId","issuedIdentifier" FROM public."issues" WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3', [ids.issue, owner, ids.workspace])).rows
      const identity = identities[0]
      if (identities.length !== 1 || identity.id !== ids.issue || identity.userId !== owner || identity.workspaceId !== ids.workspace
        || typeof identity.issuedIdentifier !== 'string' || !identity.issuedIdentifier.trim() || identity.issuedIdentifier !== identity.issuedIdentifier.trim()) throw new TestAccountError('PARITY_TASK_IDENTITY_INVALID')
      fixture.issueIdentifier = identity.issuedIdentifier
      await insert(client, 'issue_versions', { id: ids.version, issueId: ids.issue, userId: owner, revision: 1, title: fixture.issueTitle, content: JSON.stringify(content), status: 'todo', priority: 'normal', actor_type: 'user', actor_id: owner, createdAt: AT })
      await insert(client, 'mikka_team_issues', { issueId: ids.issue, teamId: ids.team, workspaceId: ids.workspace, userId: owner, createdAt: AT })
      await insert(client, 'devices', { id: ids.device, ownerId: owner, name: 'Review laptop', hostname: 'review-laptop', kind: 'local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', harnesses: '[]', enabled: false, nameLocked: true, lastSeenAt: AT, createdAt: AT, updatedAt: AT })
      await insert(client, 'agents', { id: ids.agent, userId: owner, harness: 'codex', name: 'Desktop reviewer', description: 'Review fixture', deviceId: ids.device, createdAt: AT, updatedAt: AT })
      await insert(client, 'agent_runs', { id: ids.run, userId: owner, workspaceId: ids.workspace, issueId: ids.issue, agentId: ids.agent, botId: ids.bot, deviceId: ids.device, status: 'succeeded', kind: 'implement', prompt: 'Review the desktop workspace', lastReply: 'The review is complete. Conversations, task details and artifacts are ready.', lastReplyPart: 'review-answer', lastReplyAt: AT, outcome: 'done', outcomeDecidedBy: 'decision', outcomeAt: AT, startedAt: AT, finishedAt: AT, createdAt: AT, updatedAt: AT })
      await insert(client, 'run_chunks', { id: ids.chunk, runId: ids.run, seq: 1, chunk: JSON.stringify({ type: 'text-delta', id: 'review-answer', delta: 'The review is complete. Conversations, task details and artifacts are ready.' }), createdAt: AT })
      for (const [id, version, title, kind, text] of [[ids.markdown, ids.markdownVersion, fixture.artifactTitle, 'markdown', markdown], [ids.html, ids.htmlVersion, fixture.htmlTitle, 'html', html]]) {
        await insert(client, 'artifacts', { id, userId: owner, workspaceId: ids.workspace, kind, title, runId: ids.run, issueId: ids.issue, latestVersion: 1, createdAt: AT, updatedAt: AT })
        await insert(client, 'artifact_versions', { id: version, artifactId: id, version: 1, storageKey: `desktop-parity/${id}/1`, inlineContent: text, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text), authorName: fixture.botName, createdAt: AT })
      }
      for (const [id, artifactId, token] of [[ids.markdownShare, ids.markdown, fixture.markdownToken], [ids.htmlShare, ids.html, fixture.htmlToken]]) {
        await insert(client, 'artifact_shares', { id, artifactId, tokenHash: createHash('sha256').update(token).digest('hex'), createdBy: owner, createdAt: AT })
      }
      for (const [botId, first, second, request, reply] of [
        [ids.coordinator, ids.coordinatorUser, ids.coordinatorReply, 'What should we review today?', 'Review the desktop workspace, including conversations, tasks, artifacts and settings.'],
        [ids.bot, ids.botUser, ids.botReply, 'Please review the workspace.', 'The review is complete. The task and its artifacts are ready for you.'],
      ]) for (const [id, position, role, text] of [[first, 1, 'user', request], [second, 2, 'assistant', reply]]) await insert(client, 'coordinator_messages', { id, userId: owner, botId, position, message: JSON.stringify({ role, content: text }), createdAt: AT })
      await insert(client, 'conversations', { id: ids.group, workspaceId: ids.workspace, kind: 'group', title: fixture.groupName, createdBy: owner, lastPosition: 1, leadBotId: ids.bot, createdAt: AT })
      for (const [memberType, memberId, role] of [['user', owner, 'owner'], ['user', scope.peer.userId, 'member'], ['bot', ids.bot, 'member']]) await insert(client, 'conversation_members', { conversationId: ids.group, memberType, memberId, role, joinedAt: AT })
      await insert(client, 'conversation_messages', { id: ids.groupMessage, conversationId: ids.group, position: 1, authorType: 'user', authorId: owner, body: 'The desktop review is ready. Please check the task and its artifacts.', mentions: '[]', createdAt: AT })
    })
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
  return { fixture, cleanup }
}
