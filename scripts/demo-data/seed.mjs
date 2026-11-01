// Seeds a demo team workspace for one existing account, for page-by-page review.
//
//   MIKKA_DATABASE_URL=… DATABASE_URL=… node scripts/demo-data/seed.mjs --email you@example.com          # dry run
//   MIKKA_DATABASE_URL=… DATABASE_URL=… node scripts/demo-data/seed.mjs --email you@example.com --apply  # write
//
// It writes rows directly and calls no API, so nothing it writes is sent anywhere:
// - no coordinator_events (nothing wakes a model), no group_turns, no schedules;
// - threads are finished, or running/waiting with no lease on a disabled demo
//   device that has no token, and all are older than 15 minutes, so no daemon,
//   run recovery or ops alert acts on them;
// - tasks are workspace tasks with linearSyncBlocked, so the Linear outbox
//   trigger drops them;
// - no pending_actions, billing, usage, Composio or Linear rows.
// Every row id starts with de300000- (shared.mjs); cleanup.mjs removes exactly those.
// Re-running replaces the previous demo rows of the account in one transaction.
import { connect, countDemoRows, deleteDemoRows, demoId, findOwner, inTransaction, MAIN_TABLES, parseArgs, WORKSPACE_TABLES } from './shared.mjs'
import { AGENTS, ARTIFACTS, BOT_MEMORY, BOTS, DEVICES, FACTS, ISSUES, PEOPLE, PERSONAL_ISSUES, RUNS, SUGGESTIONS, TEAM, WORKSPACE_NAME, WORKSPACE_SLUG } from './content.mjs'
import { CHATS, GROUP } from './chats.mjs'
import { createHash } from 'node:crypto'

const args = parseArgs(process.argv.slice(2))
const db = connect(args)
const now = Date.now()
const ago = minutes => new Date(now - minutes * 60_000)
const day = offset => new Date(now + offset * 86_400_000).toISOString().slice(0, 10)
const sha = text => createHash('sha256').update(text).digest('hex')
const json = value => JSON.stringify(value)

function plan(owner) {
  const id = key => demoId(owner.id, key)
  const people = PEOPLE.map(person => ({ ...person, id: id(`person:${person.key}`), email: `${id(`person:${person.key}`)}@demo.mikka.invalid` }))
  const person = key => key === 'me' ? { id: owner.id, name: owner.name } : people.find(item => item.key === key)
  const bots = BOTS.map(bot => ({ ...bot, id: id(`bot:${bot.key}`) }))
  const botOf = key => bots.find(bot => bot.key === key)
  const fill = text => text.replace(/\{\{(issue|run|bot|artifact):([\w-]+)\}\}/g, (_, kind, key) => kind === 'bot' ? botOf(key).id : id(`${kind}:${key}`))
  const fillDeep = value => JSON.parse(fill(JSON.stringify(value)))

  const assignee = key => {
    if (!key) return null
    if (key.startsWith('bot:')) { const bot = botOf(key.slice(4)); return { kind: 'agent', id: bot.id, name: bot.name, image: null } }
    const who = person(key)
    return { kind: 'member', id: who.id, name: who.name, image: null }
  }
  const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  const issueRows = [...ISSUES.map(issue => ({ ...issue, scope: 'workspace' })), ...PERSONAL_ISSUES.map(issue => ({ ...issue, scope: 'personal' }))].map((issue, index, all) => {
    const metadata = {
      // No number: numbers come from the owner's counter ("user"."lastIssueNumber", advanced by a
      // trigger on insert), and demo rows must not move the account's real numbering.
      assignee: assignee(issue.assignee), project: null, labels: issue.labels ?? [], pullRequests: issue.pullRequests ?? [],
      parentId: issue.parent ? id(`issue:${issue.parent}`) : null, blockedByIds: [], relatedIds: [],
      duplicateOfId: issue.duplicateOf ? id(`issue:${issue.duplicateOf}`) : null,
      dueDate: issue.due === undefined ? null : day(issue.due), estimate: null,
      favoriteUserIds: [], subscriberUserIds: [owner.id], deletedAt: null,
    }
    const content = { type: 'doc', attrs: { mikka: metadata }, content: [
      ...issue.body.map(paragraph),
      ...(issue.checklist ? [{ type: 'taskList', content: issue.checklist.map(([text, checked]) => ({ type: 'taskItem', attrs: { checked }, content: [paragraph(text)] })) }] : []),
    ] }
    // Older tasks further down the list: the board orders by updatedAt.
    const created = ago(60 * 24 * (3 + (all.length - index) % 9) + index * 37)
    return { id: id(`issue:${issue.key}`), key: issue.key, scope: issue.scope, title: issue.title, status: issue.status, priority: issue.priority, content, createdAt: created, updatedAt: ago(30 + index * 53) }
  })

  const devices = DEVICES.map(device => ({ ...device, id: id(`device:${device.key}`),
    lastSeenAt: device.online ? new Date(now + 10 * 365 * 86_400_000) : new Date(now - device.lastSeenMinutes * 60_000) }))
  const agents = AGENTS.map(agent => ({ ...agent, id: id(`agent:${agent.key}`), deviceId: id(`device:${agent.device}`) }))
  const runs = RUNS.map(run => {
    const createdAt = ago(run.minutesAgo)
    const startedAt = new Date(createdAt.getTime() + 40_000)
    const finished = ['succeeded', 'failed', 'stopped', 'cancelled'].includes(run.status)
    const finishedAt = finished ? new Date(startedAt.getTime() + run.minutes * 60_000) : null
    const lastReplyAt = finishedAt ?? ago(Math.max(16, Math.round(run.minutesAgo / 3)))
    return { ...run, id: id(`run:${run.key}`), issueId: run.issue ? id(`issue:${run.issue}`) : null, botId: botOf(run.bot).id,
      agentId: id(`agent:${run.agent}`), deviceId: agents.find(agent => agent.key === run.agent).deviceId,
      createdAt, startedAt, finishedAt, lastReplyAt, chunks: fillDeep(run.chunks) }
  })
  const artifacts = ARTIFACTS.map(artifact => {
    const run = runs.find(item => item.artifacts?.includes(artifact.key))
    return { ...artifact, id: id(`artifact:${artifact.key}`), runId: run?.id ?? null, issueId: run?.issueId ?? null, createdAt: run?.finishedAt ?? ago(120) }
  })

  const chats = Object.entries(CHATS).map(([key, messages]) => {
    const bot = botOf(key)
    const start = 60 * 24 * 2
    return { bot, messages: messages.map((message, index) => ({ id: id(`chat:${key}:${index}`), position: index + 1, message: fillDeep(message), createdAt: ago(start - index * Math.floor(start / (messages.length + 1))) })) }
  })
  const group = {
    id: id(`group:${GROUP.key}`), title: GROUP.title,
    members: [{ type: 'user', id: owner.id, role: 'owner' }, ...GROUP.people.map(key => ({ type: 'user', id: person(key).id, role: 'member' })), ...GROUP.bots.map(key => ({ type: 'bot', id: botOf(key).id, role: 'member' }))],
    messages: GROUP.messages.map((message, index) => {
      const [type, key] = message.by.startsWith('bot:') ? ['bot', message.by.slice(4)] : ['user', message.by]
      return { id: id(`group:${GROUP.key}:${index}`), position: index + 1, authorType: type, authorId: type === 'bot' ? botOf(key).id : person(key).id, body: message.body,
        mentions: (message.mentions ?? []).map(ref => ({ memberType: 'bot', memberId: botOf(ref.slice(4)).id })), createdAt: ago(300 - index * 25) }
    }),
  }
  return { id, people, bots, issueRows, devices, agents, runs, artifacts, chats, group }
}

function summary(p) {
  const versions = p.artifacts.reduce((total, artifact) => total + artifact.versions.length, 0)
  return {
    workspace: { mikka_workspaces: 1, mikka_workspace_members: 1 + p.people.length, mikka_teams: 1, mikka_team_members: 1 + p.people.length, mikka_team_issues: ISSUES.length },
    main: {
      user: p.people.length, bots: p.bots.length, coordinator_sessions: Object.keys(BOT_MEMORY).length, coordinator_messages: p.chats.reduce((n, chat) => n + chat.messages.length, 0),
      conversations: 1, conversation_members: p.group.members.length, conversation_messages: p.group.messages.length,
      issues: p.issueRows.length, issue_versions: p.issueRows.length, devices: p.devices.length, agents: p.agents.length, agent_runs: p.runs.length,
      run_chunks: p.runs.reduce((n, run) => n + run.chunks.length, 0), artifacts: p.artifacts.length, artifact_versions: versions,
      user_facts: FACTS.length, suggestions: SUGGESTIONS.length,
    },
    personal: { issues: PERSONAL_ISSUES.length, devices: p.devices.length, agents: p.agents.length, user_facts: FACTS.length, suggestions: SUGGESTIONS.length },
  }
}

async function writeWorkspace(client, owner, p) {
  const workspaceId = p.id('workspace')
  const teamId = p.id('team')
  await client.query('INSERT INTO mikka_workspaces (id, "userId", name, slug, "createdAt") VALUES ($1, $2, $3, $4, $5)', [workspaceId, owner.id, WORKSPACE_NAME, `${WORKSPACE_SLUG}-${workspaceId.slice(9, 13)}`, ago(60 * 24 * 14)])
  for (const member of [{ id: owner.id, name: owner.name, email: owner.email.toLowerCase(), role: 'admin' }, ...p.people]) {
    await client.query('INSERT INTO mikka_workspace_members ("workspaceId", "userId", name, email, role) VALUES ($1, $2, $3, $4, $5)', [workspaceId, member.id, member.name, member.email, member.role])
  }
  await client.query('INSERT INTO mikka_teams (id, "workspaceId", "userId", name, identifier, description) VALUES ($1, $2, $3, $4, $5, $6)', [teamId, workspaceId, owner.id, TEAM.name, TEAM.identifier, TEAM.description])
  for (const [index, member] of [owner, ...p.people].entries()) {
    await client.query('INSERT INTO mikka_team_members ("teamId", "userId", role) VALUES ($1, $2, $3)', [teamId, member.id, index === 0 ? 'owner' : 'member'])
  }
  for (const issue of p.issueRows.filter(row => row.scope === 'workspace')) {
    await client.query('INSERT INTO mikka_team_issues ("issueId", "teamId", "workspaceId", "userId") VALUES ($1, $2, $3, $4)', [issue.id, teamId, workspaceId, owner.id])
  }
  return workspaceId
}

async function writeMain(client, owner, p, workspaceId) {
  for (const person of p.people) await client.query('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, $4, $4)', [person.id, person.name, person.email, ago(60 * 24 * 20)])
  for (const bot of p.bots) {
    await client.query('INSERT INTO bots (id, "ownerId", "workspaceId", name, color, shape, model, repository, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [bot.id, owner.id, workspaceId, bot.name, bot.color, bot.shape, bot.model, bot.repository, ago(60 * 24 * 10)])
  }
  for (const [key, memory] of Object.entries(BOT_MEMORY)) {
    await client.query('INSERT INTO coordinator_sessions ("userId", "botId", memory) VALUES ($1, $2, $3)', [owner.id, p.bots.find(bot => bot.key === key).id, memory])
  }
  for (const issue of p.issueRows) {
    await client.query('INSERT INTO issues (id, "userId", title, content, status, priority, scope, "scopeSetBy", "linearSyncBlocked", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)',
      [issue.id, owner.id, issue.title, json(issue.content), issue.status, issue.priority, issue.scope, 'user', issue.createdAt, issue.updatedAt])
    await client.query('INSERT INTO issue_versions (id, "issueId", "userId", revision, title, content, status, priority, actor_type, actor_id, "createdAt") VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)',
      [p.id(`issue-version:${issue.key}`), issue.id, owner.id, issue.title, json(issue.content), issue.status, issue.priority, 'user', owner.id, issue.createdAt])
  }
  for (const device of p.devices) {
    await client.query('INSERT INTO devices (id, "ownerId", name, hostname, kind, "deviceType", platform, arch, "daemonVersion", harnesses, enabled, "autoSchedule", "nameLocked", "lastSeenAt", "createdAt") VALUES ($1, $2, $3, $4, \'local\', $5, $6, $7, $8, $9, false, $10, true, $11, $12)',
      [device.id, owner.id, device.name, device.hostname, device.deviceType, device.platform, device.arch, '0.9.4', json(device.harnesses), device.autoSchedule, device.lastSeenAt, ago(60 * 24 * 30)])
  }
  for (const agent of p.agents) {
    await client.query('INSERT INTO agents (id, "userId", harness, name, description, "deviceId") VALUES ($1, $2, $3, $4, $5, $6)', [agent.id, owner.id, agent.harness, agent.name, '', agent.deviceId])
  }
  for (const run of p.runs) {
    await client.query(`INSERT INTO agent_runs (id, "userId", "issueId", "agentId", "botId", "deviceId", status, kind, prompt, error, "lastReply", "lastReplyPart", "lastReplyAt", "startedAt", "finishedAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'implement', $8, $9, $10, 'demo', $11, $12, $13, $14, $15)`,
    [run.id, owner.id, run.issueId, run.agentId, run.botId, run.deviceId, run.status, run.prompt, run.error ?? null, run.lastReply, run.lastReplyAt, run.startedAt, run.finishedAt, run.createdAt, run.lastReplyAt])
    for (const [index, chunk] of run.chunks.entries()) {
      await client.query('INSERT INTO run_chunks (id, "runId", seq, chunk, "createdAt") VALUES ($1, $2, $3, $4, $5)', [p.id(`chunk:${run.key}:${index}`), run.id, index + 1, json(chunk), new Date(run.startedAt.getTime() + index * 45_000)])
    }
  }
  for (const artifact of p.artifacts) {
    await client.query('INSERT INTO artifacts (id, "userId", kind, title, "runId", "issueId", "latestVersion", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)',
      [artifact.id, owner.id, artifact.kind, artifact.title, artifact.runId, artifact.issueId, artifact.versions.length, artifact.createdAt])
    for (const [index, body] of artifact.versions.entries()) {
      await client.query('INSERT INTO artifact_versions (id, "artifactId", version, "storageKey", "inlineContent", sha256, size, "authorName", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [p.id(`artifact-version:${artifact.key}:${index}`), artifact.id, index + 1, `demo/${artifact.id}/${index + 1}`, body, sha(body), Buffer.byteLength(body), artifact.author, new Date(artifact.createdAt.getTime() - (artifact.versions.length - 1 - index) * 3_600_000)])
    }
  }
  for (const chat of p.chats) for (const row of chat.messages) {
    await client.query('INSERT INTO coordinator_messages (id, "userId", "botId", position, message, "createdAt") VALUES ($1, $2, $3, $4, $5, $6)', [row.id, owner.id, chat.bot.id, row.position, json(row.message), row.createdAt])
  }
  const group = p.group
  await client.query('INSERT INTO conversations (id, "workspaceId", kind, title, "createdBy", "lastPosition", "leadBotId", "createdAt") VALUES ($1, $2, \'group\', $3, $4, $5, $6, $7)', [group.id, workspaceId, group.title, owner.id, group.messages.length, p.bots.find(bot => bot.key === 'release').id, ago(60 * 24 * 3)])
  for (const member of group.members) await client.query('INSERT INTO conversation_members ("conversationId", "memberType", "memberId", role) VALUES ($1, $2, $3, $4)', [group.id, member.type, member.id, member.role])
  for (const message of group.messages) {
    await client.query('INSERT INTO conversation_messages (id, "conversationId", position, "authorType", "authorId", body, mentions, "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [message.id, group.id, message.position, message.authorType, message.authorId, message.body, json(message.mentions), message.createdAt])
  }
  for (const fact of FACTS) {
    const subjectKey = fact.subject.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').trim()
    // A real fact on the same subject wins; the demo one is then skipped.
    await client.query('INSERT INTO user_facts (id, "userId", kind, subject, "subjectKey", value, evidence, confidence, "firstSeenAt", "lastSeenAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING',
      [p.id(`fact:${fact.key}`), owner.id, fact.kind, fact.subject, subjectKey, json(fact.value), json([{ source: 'demo-data', at: ago(60 * 24 * 5).toISOString() }]), fact.confidence, ago(60 * 24 * 12), ago(60 * 24)])
  }
  for (const item of SUGGESTIONS) {
    const at = ago(item.hoursAgo * 60)
    await client.query('INSERT INTO suggestions (id, "userId", source, "externalId", action, title, url, actor, shown, "decidedBy", level, "actionTitle", required, "occurredAt", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, \'rule\', $9, $10, $11, $12, $12)',
      [p.id(`suggestion:${item.key}`), owner.id, item.source, `demo-data:${item.key}`, item.action, item.title, item.url, item.actor, item.level, item.actionTitle, item.required, at])
  }
}

try {
  const owner = await findOwner(db.main, args.email)
  const p = plan(owner)
  const existing = { main: await countDemoRows(db.main, MAIN_TABLES, owner.id), workspace: await countDemoRows(db.workspace, WORKSPACE_TABLES, owner.id) }
  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', targets: db.targets, owner: { id: owner.id, email: owner.email }, replaces: existing, writes: summary(p) }, null, 2))
  if (args.apply) {
    // Workspace rows first: the app reads bots and tasks only through a workspace the person belongs to.
    const workspaceId = await inTransaction(db.workspace, async client => { await deleteDemoRows(client, WORKSPACE_TABLES, owner.id); return writeWorkspace(client, owner, p) })
    try {
      await inTransaction(db.main, async client => { await deleteDemoRows(client, MAIN_TABLES, owner.id); await writeMain(client, owner, p, workspaceId) })
    } catch (error) {
      // Leave no half-seeded workspace behind.
      await inTransaction(db.workspace, client => deleteDemoRows(client, WORKSPACE_TABLES, owner.id))
      throw error
    }
    console.log(JSON.stringify({ written: true, workspace: { id: workspaceId, name: WORKSPACE_NAME } }))
  }
} finally {
  await Promise.all([db.main.end(), db.workspace.end()])
}
