/** One bounded, read-only APP history sample before #1782. This entry creates
 * no Task, selects no model, changes no workspace, and never prints raw rows. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { workflowGuard } from './self-hosted-closeout.mjs'
import { createSessionClient, smokeAcceptanceAccount } from '../acceptance/cloud-startup.mjs'

export const MAIN = '8db16095f46be955df22f42914e0f89b6e5f3d11'
export const ORIGIN = 'https://app.aspectlylabs.com'
const ADMIN_HASH = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{40}$/
const LABELS = new Set(['workspace', 'personal'])
const CODES = new Set(['source_refused', 'main_changed', 'build_changed', 'http_failed', 'response_invalid', 'account_refused',
  'workspace_refused', 'sample_missing', 'sample_invalid', 'sample_changed', 'database_binding', 'database_readonly',
  'sample_too_large', 'history_missing', 'migration_already_applied', 'database_failed', 'signout_failed', 'before_failed'])
const hash = value => createHash('sha256').update(value).digest('hex')
const creator = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
export const publicFailure = error => ({ code: CODES.has(error?.code) ? error.code : 'before_failed' })

export function guardContext(env, event, checkout, dirty) {
  workflowGuard(env)
  check(env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_WORKFLOW_REF === 'alexj11324/Mikka/.github/workflows/issue1782-domain-history-before.yml@refs/heads/ops/self-hosted-vault-closeout-20261108'
    && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA
    && event.deleted === false && event.forced === false && checkout === env.GITHUB_SHA
    && env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && env.GITHUB_JOB === 'domain_history_before' && SHA.test(env.GITHUB_SHA ?? '') && !dirty, 'source_refused')
}

export async function guardMain(env, fetchImpl = fetch) {
  check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'source_refused')
  const read = async (url, headers = {}) => {
    const response = await fetchImpl(url, { headers: { 'cache-control': 'no-store', ...headers },
      redirect: 'error', signal: AbortSignal.timeout(15000) })
    check(response.ok, 'http_failed')
    return response.json()
  }
  const main = await read('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main',
    { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' })
  check(main.ref === 'refs/heads/main' && main.object?.sha === MAIN && main.object?.type === 'commit', 'main_changed')
  const version = await read(ORIGIN + '/mikka/api/version')
  check(version.build === MAIN, 'build_changed')
  return { mainSha: MAIN, servedBuild: version.build, origin: ORIGIN, checkedAt: new Date().toISOString() }
}

/** Only ordinary account API choices can nominate a workspace. Search accepts
 * an explicit business target; detail reads use the existing request preference. */
export function candidateInventory(rows, ownerId) {
  check(Array.isArray(rows) && rows.length <= 100 && rows.every(row => UUID.test(row?.id))
    && new Set(rows.map(row => row.id)).size === rows.length && typeof ownerId === 'string' && ownerId.length > 0, 'sample_invalid')
  const own = rows.filter(row => row.ownerId === ownerId)
  const count = (values, label) => values.filter(row => row.scope === label).length
  return {
    // The relation-search DTO deliberately omits scope; APP and exact detail
    // reads still enforce the two legal labels. An explicit unknown value is refused.
    candidateTaskIds: rows.filter(row => creator(row.ownerId) && (row.scope === undefined || LABELS.has(row.scope))).map(row => row.id).sort(),
    taskOwners: Object.fromEntries(rows.filter(row => creator(row.ownerId) && (row.scope === undefined || LABELS.has(row.scope))).map(row => [row.id, row.ownerId])),
    counts: { returned: rows.length, ownerIdFieldPresent: rows.filter(row => typeof row.ownerId === 'string').length,
      own: own.length, ownWorkspace: count(own, 'workspace'), ownPersonal: count(own, 'personal'),
      ownUnknownScope: own.filter(row => row.scope !== undefined && !LABELS.has(row.scope)).length,
      ownScopeOmitted: own.filter(row => row.scope === undefined).length,
      workspaceLabel: count(rows, 'workspace'), personalLabel: count(rows, 'personal'),
      unknownScope: rows.filter(row => row.scope !== undefined && !LABELS.has(row.scope)).length,
      scopeOmitted: rows.filter(row => row.scope === undefined).length, listCapacityReached: rows.length === 100 },
  }
}

/** Use the existing relation-picker's real cursor, never fabricate a cursor or
 * search all APP rows. Read at most five authorized pages and retain <=100 IDs. */
export async function searchCandidates(client, scope, observeInventory = () => {}) {
  check(UUID.test(scope.workspaceId) && typeof scope.ownerId === 'string' && scope.ownerId.length > 0, 'sample_invalid')
  const ids = new Set(), taskOwners = {}, seenRows = new Set(), seenCursors = new Set()
  let cursor = null
  const counts = { pages: 0, returned: 0, own: 0, ownWorkspace: 0, ownPersonal: 0, ownUnknownScope: 0,
    ownScopeOmitted: 0, ownerIdFieldPresent: 0, candidateCount: 0, hasMore: false, pageLimitReached: false,
    candidateLimitReached: false, pageSize: 50, maxPages: 5, maxCandidates: 100 }
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ workspaceId: scope.workspaceId, limit: '50', q: '' })
    if (cursor !== null) query.set('cursor', cursor)
    const result = await client.json('/api/issues/search?' + query)
    check(Array.isArray(result.items) && result.items.length <= 50 && result.truncated === false
      && (result.nextCursor === null || typeof result.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(result.nextCursor)), 'response_invalid')
    const inventory = candidateInventory(result.items, scope.ownerId)
    check(result.items.every(row => !seenRows.has(row.id)), 'sample_invalid')
    for (const row of result.items) seenRows.add(row.id)
    for (const id of inventory.candidateTaskIds) if (ids.size < 100) { ids.add(id); taskOwners[id] = inventory.taskOwners[id] }
    counts.pages++; counts.returned += result.items.length
    for (const key of ['own', 'ownWorkspace', 'ownPersonal', 'ownUnknownScope', 'ownScopeOmitted', 'ownerIdFieldPresent']) counts[key] += inventory.counts[key]
    counts.candidateCount = ids.size; counts.hasMore = result.nextCursor !== null
    counts.pageLimitReached = counts.pages === 5 && counts.hasMore
    counts.candidateLimitReached = ids.size === 100 && counts.hasMore
    observeInventory({ ...counts })
    if (!counts.hasMore || ids.size === 100) break
    check(result.items.length > 0 && !seenCursors.has(result.nextCursor), 'response_invalid')
    seenCursors.add(result.nextCursor); cursor = result.nextCursor
  }
  return { candidateTaskIds: [...ids].sort(), taskOwners, counts }
}

export async function selectScope(client, email, observeInventory = () => {}) {
  const session = await client.json('/api/auth/get-session')
  const ownerId = session?.user?.id
  check(typeof ownerId === 'string' && ownerId.length > 0 && session.user.email?.trim().toLowerCase() === email.trim().toLowerCase(), 'account_refused')
  const initial = await client.json('/api/workspace')
  check(initial.currentUserId === ownerId && Array.isArray(initial.choices), 'workspace_refused')
  // The existing public policy-admin anchor identifies the authorized shared
  // Workspace. The display name, creator and compatibility scope grant nothing.
  const choices = initial.choices.filter(row => row?.kind === 'team')
  check(choices.length > 0 && choices.length <= 32 && choices.every(row => UUID.test(row.id))
    && new Set(choices.map(row => row.id)).size === choices.length, 'workspace_refused')
  const matches = []
  for (const choice of choices) {
    const adminId = sharedWorkspace(await client.json('/api/workspace?workspace=' + choice.id), ownerId, choice.id, 'workspace_refused')
    if (adminId !== null) matches.push({ workspaceId: choice.id, adminId })
  }
  check(matches.length === 1, 'workspace_refused')
  const { workspaceId, adminId } = matches[0]
  const { candidateTaskIds, taskOwners } = await searchCandidates(client, { ownerId, workspaceId }, observeInventory)
  check(candidateTaskIds.length > 0, 'sample_missing')
  const scope = { ownerId, workspaceId, workspaceKind: 'team', adminId, candidateTaskIds, taskOwners }
  // Every candidate needs a fresh ordinary detail read before APP is opened.
  // The returned map is private memory; only per-Task hashes enter the artifact.
  await verifyScope(client, { ...scope, taskIds: candidateTaskIds })
  return scope
}

function sharedWorkspace(value, ownerId, workspaceId, code) {
  check(value?.currentUserId === ownerId && value.workspace?.id === workspaceId && value.workspace.kind === 'team'
    && ['member', 'admin'].includes(value.role) && Array.isArray(value.choices) && Array.isArray(value.members), code)
  const choices = value.choices.filter(row => row?.id === workspaceId)
  const members = value.members.filter(row => row?.userId === ownerId)
  check(choices.length === 1 && choices[0].kind === 'team' && members.length === 1
    && members[0].status === 'active' && members[0].role === value.role, code)
  const admins = value.members.filter(row => row?.userId !== ownerId && creator(row?.userId) && row.role === 'admin'
    && row.status === 'active' && typeof row.email === 'string' && hash(row.email.trim().toLowerCase()) === ADMIN_HASH)
  check(admins.length <= 1, code)
  return admins[0]?.userId ?? null
}

function pairedCreators(scope, ids) {
  check(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(id => UUID.test(id))
    && new Set(ids).size === ids.length && scope.taskOwners && ids.every(id => Object.hasOwn(scope.taskOwners, id) && creator(scope.taskOwners[id])), 'sample_invalid')
  return ids.map(id => scope.taskOwners[id])
}

export async function verifyScope(client, scope) {
  pairedCreators(scope, scope.taskIds)
  const session = await client.json('/api/auth/get-session')
  check(session?.user?.id === scope.ownerId && scope.workspaceKind === 'team' && UUID.test(scope.workspaceId)
    && creator(scope.adminId), 'sample_changed')
  const membership = async () => check(sharedWorkspace(await client.json('/api/workspace?workspace=' + scope.workspaceId),
    scope.ownerId, scope.workspaceId, 'sample_changed') === scope.adminId, 'sample_changed')
  await membership()
  // Exact IDs can be older than the newest list page. The existing request
  // preference is membership checked, and does not mutate the account's cookie.
  // Normal getIssue performs fresh authorization; no body, title or prompt enters the report.
  // At most four in-flight reads, no retries. A refusal stops new work and all
  // already-started reads settle before caller cleanup or any database access.
  let next = 0, failure
  const worker = async () => {
    while (!failure && next < scope.taskIds.length) {
      const id = scope.taskIds[next++]
      try {
        const value = await client.rpc('issues.getIssue', [id], { headers: { 'x-mikka-workspace-id': scope.workspaceId } }), issue = value?.issue
        check(issue?.id === id && issue.userId === scope.taskOwners[id] && issue.workspaceId === scope.workspaceId
          && issue.ownershipState === 'bound' && LABELS.has(issue.scope), 'sample_changed')
      } catch (error) { failure ??= error }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, scope.taskIds.length) }, worker))
  if (failure) throw failure
  await membership()
}

// Constant SQL only. UUIDs and their independently API-authorized creators are
// paired, never independent ANY sets. Ordinary Task visibility does not grant
// another user's Run content: only the rollout's operational digest is read.
// Raw execution definitions are hashed inside PostgreSQL, never transported.
const AUTHORIZED = `WITH authorized AS (
    SELECT * FROM unnest($1::uuid[], $2::text[]) AS a(id, creator)
  ), tasks AS (
    SELECT i.id, i."userId", i."workspaceId", i."ownershipState", i.scope,
      coalesce(to_jsonb(i)->>'issuedIdentifier','') AS identifier FROM issues i JOIN authorized a ON a.id=i.id AND a.creator=i."userId"
    WHERE i."workspaceId"=$3::uuid AND i."ownershipState"='bound' AND i.scope IN ('workspace','personal')
  )`
const PUBLISHED = `EXISTS (SELECT 1 FROM run_publications p JOIN agent_runs r ON r.id=p."runId"
      AND r."issueId"=p."issueId" AND r."userId"=p."userId"
      WHERE p."issueId"=i.id AND r."workspaceId"=i."workspaceId" AND p.status='published')`
const ENDED = `EXISTS (SELECT 1 FROM agent_runs r WHERE r."issueId"=i.id AND r."workspaceId"=i."workspaceId"
      AND r.status IN ('succeeded','stopped','failed','cancelled'))`
// Exact Epic identities from product scripts/migration-order.mjs. P0 081202 /
// 090350 and Coding 091431 migrations are distinct and do not invalidate before.
export const EPIC_MIGRATIONS = Object.freeze({
  canonical: Object.freeze([
    '20261109143000_project_v2.sql', '20261109143001_task_identity.sql', '20261109143002_task_identity_aliases.sql',
    '20261109143003_team_lifecycle.sql', '20261109143004_project_resources.sql', '20261109143005_project_lifecycle.sql',
    '20261109143006_project_history_retention.sql', '20261109143007_task_alias_tenant.sql', '20261109143008_project_writer_fence.sql',
  ]),
  legacy: Object.freeze([
    '20261108120300_project_v2.sql', '20261108120301_task_identity.sql', '20261108120302_task_identity_aliases.sql',
    '20261108120303_team_lifecycle.sql', '20261108120304_project_resources.sql', '20261108120305_project_lifecycle.sql',
    '20261108120306_project_history_retention.sql', '20261108120307_task_alias_tenant.sql', '20261108120308_project_writer_fence.sql',
  ]),
})
export const SQL = Object.freeze({
  settings: `SELECT current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation`,
  ledger: `SELECT count(*) FILTER (WHERE name IN (${EPIC_MIGRATIONS.canonical.map(name => "'" + name + "'").join(',')}))::int AS epic,
    count(*) FILTER (WHERE name IN (${EPIC_MIGRATIONS.legacy.map(name => "'" + name + "'").join(',')}))::int AS legacy,
    md5(coalesce(string_agg(name, E'\\n' ORDER BY name),'')) AS digest FROM schema_migrations`,
  binding: `WITH authorized AS (SELECT * FROM unnest($1::uuid[], $2::text[]) AS a(id, creator)), candidates AS (
    SELECT i.id, i."userId"=a.creator AND i."workspaceId"=$3::uuid AND i."ownershipState"='bound'
      AND i.scope IN ('workspace','personal') AS matches_scope,
      ${PUBLISHED} AS published, ${ENDED} AS ended
    FROM issues i JOIN authorized a ON a.id=i.id
    ) SELECT count(*)::int AS present, count(*) FILTER (WHERE matches_scope)::int AS "bound",
      count(*) FILTER (WHERE matches_scope AND published)::int AS published,
      count(*) FILTER (WHERE matches_scope AND ended)::int AS ended,
      count(*) FILTER (WHERE matches_scope AND published AND ended)::int AS historical FROM candidates`,
  select: `${AUTHORIZED} SELECT i.id FROM tasks i WHERE ${PUBLISHED} AND ${ENDED}
    ORDER BY EXISTS (SELECT 1 FROM agent_runs r WHERE r."issueId"=i.id AND r."workspaceId"=i."workspaceId"
      AND r.status IN ('succeeded','stopped','failed','cancelled') AND r."agentDefinition"->'projectExecution' IS NOT NULL) DESC,
      i.id LIMIT 10`,
  task: `${AUTHORIZED} SELECT id, "userId" AS owner, scope, "ownershipState" AS state,
    "workspaceId" AS workspace,
    identifier
    FROM tasks i ORDER BY id`,
  publication: `${AUTHORIZED} SELECT p."runId" AS id, p."issueId" AS "issueId", p.identifier, p.branch,
    p."baseBranch" AS "baseBranch", p."remoteKey" AS "remoteKey"
    FROM run_publications p JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=p."issueId" AND r."userId"=p."userId"
    JOIN tasks i ON i.id=p."issueId" AND i."workspaceId"=r."workspaceId"
    WHERE p.status='published' ORDER BY p."runId" LIMIT 1001`,
  run: `${AUTHORIZED} SELECT r.id, r."issueId" AS "issueId", r."agentDefinition"->'projectExecution' IS NOT NULL AS "hasProjectSnapshot",
    md5(jsonb_build_object('agentDefinition',r."agentDefinition",'baseBranch',r."baseBranch")::text) AS "frozenDigest"
    FROM agent_runs r JOIN tasks i ON i.id=r."issueId" AND i."workspaceId"=r."workspaceId"
    WHERE r.status IN ('succeeded','stopped','failed','cancelled') ORDER BY r.id LIMIT 1001`,
})

export function projectRows(scope, rows) {
  check(Array.isArray(scope.taskIds) && scope.taskIds.length > 0 && scope.taskIds.length <= 10
    && scope.taskIds.every(id => UUID.test(id)) && new Set(scope.taskIds).size === scope.taskIds.length, 'sample_invalid')
  pairedCreators(scope, scope.taskIds)
  check(rows.task.length === scope.taskIds.length && rows.task.every(row => scope.taskIds.includes(row.id)
    && row.owner === scope.taskOwners[row.id] && row.workspace === scope.workspaceId && row.state === 'bound' && LABELS.has(row.scope))
    && new Set(rows.task.map(row => row.id)).size === scope.taskIds.length, 'database_binding')
  check(rows.publication.length > 0 && rows.run.length > 0, 'history_missing')
  for (const kind of ['publication', 'run']) {
    check(rows[kind].length <= 1000, 'sample_too_large')
    check(rows[kind].every(row => UUID.test(row.id) && scope.taskIds.includes(row.issueId))
      && new Set(rows[kind].map(row => row.id)).size === rows[kind].length, 'sample_invalid')
  }
  check(rows.run.every(row => typeof row.hasProjectSnapshot === 'boolean' && /^[a-f0-9]{32}$/.test(row.frozenDigest)), 'sample_invalid')
  check(scope.taskIds.every(id => rows.publication.some(row => row.issueId === id) && rows.run.some(row => row.issueId === id)), 'history_missing')
  const field = value => { check(value === null || typeof value === 'string' && value.length <= 8192, 'sample_invalid'); return hash(JSON.stringify(value)) }
  const result = {
    task: rows.task.map(row => ({ id: row.id, workspaceId: row.workspace, creatorSha256: hash(row.owner),
      issuedIdentifierPresent: row.identifier !== '', issuedIdentifierSha256: field(row.identifier) })),
    publication: rows.publication.map(row => ({ id: row.id, issueId: row.issueId,
      ...Object.fromEntries(['identifier', 'branch', 'baseBranch', 'remoteKey'].map(key => [key + 'Sha256', field(row[key])])) })),
    run: rows.run.map(row => ({ id: row.id, issueId: row.issueId,
      hasProjectSnapshot: row.hasProjectSnapshot, frozenDigest: row.frozenDigest })),
  }
  for (const values of Object.values(result)) values.sort((a, b) => a.id.localeCompare(b.id))
  return result
}

export async function snapshot(db, scope, observe = () => {}) {
  check(Array.isArray(scope.candidateTaskIds) && scope.candidateTaskIds.length > 0 && scope.candidateTaskIds.length <= 100
    && scope.candidateTaskIds.every(id => UUID.test(id)) && new Set(scope.candidateTaskIds).size === scope.candidateTaskIds.length
    && UUID.test(scope.workspaceId) && typeof scope.ownerId === 'string' && scope.ownerId.length > 0, 'sample_invalid')
  const candidates = [scope.candidateTaskIds, pairedCreators(scope, scope.candidateTaskIds), scope.workspaceId]
  let begun = false
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true
    await db.query("SET LOCAL statement_timeout = '20s'")
    await db.query("SET LOCAL lock_timeout = '2s'")
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const settings = (await db.query(SQL.settings)).rows[0]
    check(settings?.readonly === 'on' && settings.isolation === 'repeatable read', 'database_readonly')
    observe({ lastReadStage: 'read_only_verified', readOnly: true, isolation: 'repeatable read' })
    const ledger = (await db.query(SQL.ledger)).rows[0]
    check(ledger && ['epic', 'legacy'].every(key => Number.isSafeInteger(ledger[key]) && ledger[key] >= 0 && ledger[key] <= 9)
      && /^[a-f0-9]{32}$/.test(ledger.digest), 'migration_already_applied')
    observe({ lastReadStage: ledger.epic === 0 && ledger.legacy === 0 ? 'ledger_verified' : 'ledger_refused',
      ledgerDigest: ledger.digest, canonicalEpicMigrations: ledger.epic, legacyEpicMigrations: ledger.legacy })
    check(ledger.epic === 0 && ledger.legacy === 0, 'migration_already_applied')
    const binding = (await db.query(SQL.binding, candidates)).rows[0]
    const keys = ['present', 'bound', 'published', 'ended', 'historical']
    check(binding && keys.every(key => Number.isSafeInteger(binding[key]) && binding[key] >= 0 && binding[key] <= scope.candidateTaskIds.length), 'database_binding')
    const candidateCounts = Object.fromEntries(keys.map(key => [key, binding[key]]))
    observe({ lastReadStage: 'candidate_binding', candidateCounts })
    check(binding.present === scope.candidateTaskIds.length && binding.bound === scope.candidateTaskIds.length, 'database_binding')
    const selected = (await db.query(SQL.select, candidates)).rows
    observe({ lastReadStage: 'history_selection', selectedCount: selected.length })
    check(selected.length > 0, 'history_missing')
    check(selected.length <= 10 && selected.every(row => scope.candidateTaskIds.includes(row.id))
      && new Set(selected.map(row => row.id)).size === selected.length, 'sample_invalid')
    const taskIds = selected.map(row => row.id).sort()
    const selectedPairs = [taskIds, pairedCreators(scope, taskIds), scope.workspaceId]
    const rows = {}
    for (const kind of ['task', 'publication', 'run']) rows[kind] = (await db.query(SQL[kind], selectedPairs)).rows
    return { taskIds, candidateCount: scope.candidateTaskIds.length, rows: projectRows({ ...scope, taskIds }, rows), ledgerDigest: ledger.digest,
      readOnly: true, isolation: 'repeatable read', statementTimeoutMs: 20000, lockTimeoutMs: 2000 }
  } finally {
    if (begun) { await db.query('ROLLBACK'); observe({ transactionRolledBack: true }) }
  }
}

async function main(operation) {
  check(['check', 'capture'].includes(operation), 'source_refused')
  const env = process.env
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16384 }).trim()
  guardContext(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), git('rev-parse', 'HEAD'), git('status', '--porcelain', '--untracked-files=all') !== '')
  const before = await guardMain(env)
  if (operation === 'check') { console.log(JSON.stringify({ phase: 'before', mainSha: MAIN, sourceVerified: true })); return }
  const { email, password } = smokeAcceptanceAccount(env)
  check(typeof env.MIKKA_DATABASE_URL === 'string' && env.MIKKA_DATABASE_URL.length > 0, 'database_binding')
  const target = new URL(env.MIKKA_DATABASE_URL)
  check(['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname && target.pathname, 'database_binding')
  const { Pool } = createRequire(resolve(env.DOMAIN_HISTORY_DEPENDENCIES, 'package.json'))('pg')
  let cleaning = false
  const deadline = AbortSignal.timeout(100000)
  const client = createSessionClient(ORIGIN, (url, init) => fetch(url, { ...init,
    signal: cleaning ? AbortSignal.timeout(10000) : AbortSignal.any([deadline, init.signal, AbortSignal.timeout(10000)]) }))
  const report = { version: 2, issue: 1687, batch: 1782, phase: 'before', status: 'incomplete',
    opsSource: env.GITHUB_SHA, mainSha: MAIN, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    sourceSha256: hash(await readFile(new URL(import.meta.url))), before, startedAt: new Date().toISOString(),
    cleanup: { databaseConnectionClosed: false, transactionRolledBack: false, signedOut: false },
    scope: 'at_most_ten_existing_shared_tasks_authorized_by_normal_api',
    limitations: ['bounded_sample_not_all_history', 'api_database_entity_match_not_vercel_environment_inspection',
      'normal_api_read_maintenance_writes_not_measured', 'before_only_after_same_uuids_required'] }
  let pool, signedIn = false
  try {
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    signedIn = true; check(login.ok, 'account_refused')
    const scope = await selectScope(client, email, counts => { report.apiTaskInventory = counts })
    report.candidateCount = scope.candidateTaskIds.length
    report.workspaceId = scope.workspaceId
    report.workspaceKind = scope.workspaceKind
    report.selectionBasis = 'normal_api_unique_policy_admin_workspace_and_per_task_detail_acl'
    report.readerSha256 = hash(scope.ownerId)
    report.policyAdminSha256 = hash(scope.adminId)
    report.apiAuthorization = { mode: 'shared_workspace_per_task_detail_acl', taskCount: scope.candidateTaskIds.length,
      allPassed: true, maximumConcurrentReads: 4, retries: 0 }
    report.databaseTargetSha256 = hash('app-db-target\0' + target.hostname + '\0' + target.pathname)
    await guardMain(env)
    pool = new Pool({ connectionString: env.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000,
      query_timeout: 25000, application_name: 'mikka-1782-domain-history-before', options: '-c default_transaction_read_only=on' })
    pool.on('error', () => { report.connectionError = true })
    const db = await pool.connect()
    try {
      report.snapshot = await snapshot(db, scope, evidence => {
        report.databaseEvidence = { ...report.databaseEvidence, ...evidence }
        if (evidence.transactionRolledBack === true) report.cleanup.transactionRolledBack = true
      })
      scope.taskIds = report.snapshot.taskIds; report.taskIds = scope.taskIds
    }
    finally { db.release() }
    await verifyScope(client, scope)
    report.after = await guardMain(env)
    check(!report.connectionError, 'database_failed')
    report.status = 'captured_before'
  } catch (error) { report.failure = publicFailure(error); report.status = 'failed' }
  finally {
    cleaning = true
    if (pool) { try { await pool.end(); report.cleanup.databaseConnectionClosed = true } catch { report.status = 'failed' } }
    else report.cleanup.databaseConnectionClosed = true
    if (signedIn) {
      try { const out = await client.request('/api/auth/sign-out', post({})); check(out.ok, 'signout_failed'); report.cleanup.signedOut = true }
      catch { report.status = 'failed'; report.cleanup.signoutFailure = true }
    }
    client.clear()
    report.completedAt = new Date().toISOString()
    const output = resolve(env.RUNNER_TEMP, 'domain-history-before-1782')
    await mkdir(output, { recursive: true, mode: 0o700 })
    const bytes = JSON.stringify(report, null, 2) + '\n'
    await writeFile(resolve(output, 'before.json'), bytes, { mode: 0o600 })
    const receipt = { phase: 'before', status: report.status, opsSource: env.GITHUB_SHA, mainSha: MAIN,
      runId: env.GITHUB_RUN_ID, runAttempt: 1, evidenceSha256: hash(bytes),
      counts: report.snapshot ? Object.fromEntries(Object.entries(report.snapshot.rows).map(([key, rows]) => [key, rows.length])) : null,
      cleanup: report.cleanup, ...(report.failure ? { failure: report.failure } : {}) }
    await writeFile(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(receipt))
  }
  if (report.status !== 'captured_before') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(JSON.stringify(publicFailure(error))); process.exitCode = 1 })
}
