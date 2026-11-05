import { createHash, randomUUID } from 'node:crypto'

const AT = '2026-01-15T12:00:00.000Z'
const quote = value => `"${value.replaceAll('"', '""')}"`

/** Real application rows, confined to a leased pair and freshly reserved IDs.
 * No provider, auth, RPC or UI response is simulated. The disabled device and
 * ended run never dispatch work or spend model/provider credits. */
export async function createParityFixtures(scope) {
  await scope.assertActive()
  const ids = Object.fromEntries(['workspace', 'team', 'coordinator', 'bot', 'issue', 'version', 'device', 'agent', 'run', 'chunk', 'group', 'groupMessage', 'markdown', 'markdownVersion', 'html', 'htmlVersion', 'coordinatorUser', 'coordinatorReply', 'botUser', 'botReply'].map(key => [key, randomUUID()]))
  const fixture = {
    ...ids, workspaceName: 'Desktop acceptance', teamName: 'Application', botName: 'Ada', groupName: 'Release review',
    issueTitle: 'Review the desktop workspace', artifactTitle: 'Desktop review notes', htmlTitle: 'Desktop review preview',
  }
  const resources = [
    ['workspaces', ids.workspace], ['workspace_members', ids.workspace],
    ['teams', ids.team], ['team_members', ids.team], ['team_issues', ids.issue],
    ['bots', ids.coordinator], ['bots', ids.bot], ['coordinator_bots', ids.coordinator],
    ['coordinator_sessions', ids.coordinator], ['coordinator_sessions', ids.bot],
    ['issues', ids.issue], ['issue_versions', ids.version], ['devices', ids.device], ['agents', ids.agent],
    ['agent_runs', ids.run], ['run_chunks', ids.chunk],
    ['conversations', ids.group], ['conversation_members', ids.group], ['conversation_messages', ids.groupMessage],
    ['artifacts', ids.markdown], ['artifact_versions', ids.markdownVersion], ['artifacts', ids.html], ['artifact_versions', ids.htmlVersion],
    ...[ids.coordinatorUser, ids.coordinatorReply, ids.botUser, ids.botReply].map(id => ['coordinator_messages', id]),
    ...[ids.coordinator, ids.bot, ids.group, ids.run].map(id => ['conversation_reads', id]),
  ]
  // Reservation uses the pool's owner, environment, generation and absence
  // checks. A failed insertion still leaves a cleanup record for every ID.
  for (const [type, id] of resources) await scope.recordResource({ type, id, ownerId: scope.owner.userId })
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
    await client.query(`INSERT INTO public.${quote(table)} (${entries.map(([key]) => quote(key)).join(',')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(',')})`, entries.map(([, value]) => value))
  }
  async function cleanup() {
    // Each predicate is a fresh fixture identifier reserved above. Existing
    // user/account rows and personal workspaces are never cleanup targets.
    await transaction(async client => {
      const remove = (table, key, values) => client.query(`DELETE FROM public.${quote(table)} WHERE ${quote(key)}::text = ANY($1::text[])`, [values])
      await client.query('DELETE FROM public.conversation_reads WHERE "userId"=$1 AND "conversationId"=ANY($2::text[])', [scope.owner.userId, [ids.coordinator, ids.bot, ids.group, ids.run]])
      for (const [table, key, values] of [
        ['conversation_messages', 'conversationId', [ids.group]], ['conversation_members', 'conversationId', [ids.group]], ['conversations', 'id', [ids.group]],
        ['artifact_versions', 'artifactId', [ids.markdown, ids.html]], ['artifacts', 'id', [ids.markdown, ids.html]],
        ['run_chunks', 'runId', [ids.run]], ['agent_runs', 'id', [ids.run]], ['agents', 'id', [ids.agent]], ['devices', 'id', [ids.device]],
        ['issue_versions', 'issueId', [ids.issue]], ['issue_documents', 'issueId', [ids.issue]], ['mikka_team_issues', 'issueId', [ids.issue]], ['issues', 'id', [ids.issue]],
        ['coordinator_messages', 'botId', [ids.coordinator, ids.bot]], ['coordinator_sessions', 'botId', [ids.coordinator, ids.bot]],
        ['coordinator_bots', 'botId', [ids.coordinator]], ['bots', 'id', [ids.coordinator, ids.bot]],
        ['mikka_team_members', 'teamId', [ids.team]], ['mikka_teams', 'id', [ids.team]],
        ['mikka_workspace_members', 'workspaceId', [ids.workspace]], ['mikka_workspaces', 'id', [ids.workspace]],
      ]) await remove(table, key, values)
    })
    for (const [type, id] of resources) await scope.markResourceCleaned({ type, id })
  }
  try {
    await transaction(async client => {
      const owner = scope.owner.userId
      const users = (await client.query('SELECT id,name,email FROM public."user" WHERE id=ANY($1::text[])', [[owner, scope.peer.userId]])).rows
      if (users.length !== 2) throw new Error('PARITY_LEASE_USERS_MISSING')
      fixture.dynamicIdentityEmails = users.map(user => user.email)
      await insert(client, 'mikka_workspaces', { id: ids.workspace, userId: owner, name: fixture.workspaceName, slug: `desktop-review-${scope.lease.pairId}`, kind: 'team', createdAt: AT })
      for (const user of users) await insert(client, 'mikka_workspace_members', { workspaceId: ids.workspace, userId: user.id, name: user.name, email: user.email, role: user.id === owner ? 'admin' : 'member', status: 'active', createdAt: AT })
      await insert(client, 'mikka_teams', { id: ids.team, workspaceId: ids.workspace, userId: owner, name: fixture.teamName, identifier: 'APP', description: 'Desktop application review', createdAt: AT, updatedAt: AT })
      for (const user of users) await insert(client, 'mikka_team_members', { teamId: ids.team, userId: user.id, role: user.id === owner ? 'owner' : 'member', createdAt: AT })
      for (const [id, name, color, role] of [[ids.coordinator, 'Coordinator', 'encre', ''], [ids.bot, fixture.botName, 'turquoise', 'Reviews application changes and reports results.']]) {
        await insert(client, 'bots', { id, ownerId: owner, workspaceId: ids.workspace, name, color, shape: 'cercle', publicRole: role, createdAt: AT, updatedAt: AT })
      }
      await insert(client, 'coordinator_bots', { ownerId: owner, workspaceId: ids.workspace, botId: ids.coordinator, createdAt: AT })
      await insert(client, 'issues', { id: ids.issue, userId: owner, title: fixture.issueTitle, content: JSON.stringify(content), status: 'todo', priority: 'medium', scope: 'workspace', scopeSetBy: 'user', linearSyncBlocked: true, createdAt: AT, updatedAt: AT })
      await insert(client, 'issue_versions', { id: ids.version, issueId: ids.issue, userId: owner, revision: 1, title: fixture.issueTitle, content: JSON.stringify(content), status: 'todo', priority: 'medium', actor_type: 'user', actor_id: owner, createdAt: AT })
      await insert(client, 'mikka_team_issues', { issueId: ids.issue, teamId: ids.team, workspaceId: ids.workspace, userId: owner, createdAt: AT })
      await insert(client, 'devices', { id: ids.device, ownerId: owner, name: 'Review laptop', hostname: 'review-laptop', kind: 'local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', harnesses: '[]', enabled: false, nameLocked: true, lastSeenAt: AT, createdAt: AT, updatedAt: AT })
      await insert(client, 'agents', { id: ids.agent, userId: owner, harness: 'codex', name: 'Desktop reviewer', description: 'Review fixture', deviceId: ids.device, createdAt: AT, updatedAt: AT })
      await insert(client, 'agent_runs', { id: ids.run, userId: owner, issueId: ids.issue, agentId: ids.agent, botId: ids.bot, deviceId: ids.device, status: 'succeeded', kind: 'implement', prompt: 'Review the desktop workspace', lastReply: 'The review is complete. Conversations, task details and artifacts are ready.', lastReplyPart: 'review-answer', lastReplyAt: AT, outcome: 'done', outcomeDecidedBy: 'decision', outcomeAt: AT, startedAt: AT, finishedAt: AT, createdAt: AT, updatedAt: AT })
      await insert(client, 'run_chunks', { id: ids.chunk, runId: ids.run, seq: 1, chunk: JSON.stringify({ type: 'text-delta', id: 'review-answer', delta: 'The review is complete. Conversations, task details and artifacts are ready.' }), createdAt: AT })
      for (const [id, version, title, kind, text] of [[ids.markdown, ids.markdownVersion, fixture.artifactTitle, 'markdown', markdown], [ids.html, ids.htmlVersion, fixture.htmlTitle, 'html', html]]) {
        await insert(client, 'artifacts', { id, userId: owner, kind, title, runId: ids.run, issueId: ids.issue, latestVersion: 1, createdAt: AT, updatedAt: AT })
        await insert(client, 'artifact_versions', { id: version, artifactId: id, version: 1, storageKey: `desktop-parity/${id}/1`, inlineContent: text, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text), authorName: fixture.botName, createdAt: AT })
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
