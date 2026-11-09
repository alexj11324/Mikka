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

export const MAIN = 'e189d7652fd2fce48b77a3697abf5bb177d8ebd1'
export const ORIGIN = 'https://app.aspectlylabs.com'
const ADMIN_HASH = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA = /^[0-9a-f]{40}$/
const LABELS = new Set(['workspace', 'personal'])
const CODES = new Set(['source_refused', 'main_changed', 'build_changed', 'http_failed', 'response_invalid', 'account_refused',
  'workspace_refused', 'sample_missing', 'sample_invalid', 'sample_changed', 'database_binding', 'database_readonly',
  'sample_too_large', 'history_missing', 'migration_already_applied', 'database_failed', 'signout_failed', 'before_failed'])
const hash = value => createHash('sha256').update(value).digest('hex')
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
    candidateTaskIds: own.filter(row => row.scope === undefined || LABELS.has(row.scope)).map(row => row.id).sort(),
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
 * search all APP rows. Read at most five authorized pages and retain <=100 own IDs. */
export async function searchCandidates(client, scope, observeInventory = () => {}) {
  check(UUID.test(scope.workspaceId) && typeof scope.ownerId === 'string' && scope.ownerId.length > 0, 'sample_invalid')
  const ids = new Set(), seenRows = new Set(), seenCursors = new Set()
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
    for (const id of inventory.candidateTaskIds) if (ids.size < 100) ids.add(id)
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
  return { candidateTaskIds: [...ids].sort(), counts }
}

export async function selectScope(client, email, observeInventory = () => {}) {
  const session = await client.json('/api/auth/get-session')
  const ownerId = session?.user?.id
  check(typeof ownerId === 'string' && ownerId.length > 0 && session.user.email?.trim().toLowerCase() === email.trim().toLowerCase(), 'account_refused')
  const initial = await client.json('/api/workspace')
  check(initial.currentUserId === ownerId && Array.isArray(initial.choices), 'workspace_refused')
  const choices = initial.choices.filter(row => row.kind === 'team')
  check(choices.length > 0 && choices.length <= 32 && choices.every(row => UUID.test(row.id))
    && new Set(choices.map(row => row.id)).size === choices.length, 'workspace_refused')
  const matches = []
  for (const choice of choices) {
    const value = await client.json('/api/workspace?workspace=' + choice.id)
    check(value.currentUserId === ownerId && value.workspace?.id === choice.id && value.workspace.kind === 'team'
      && ['member', 'admin'].includes(value.role) && Array.isArray(value.members), 'workspace_refused')
    const admins = value.members.filter(member => member.userId !== ownerId && member.role === 'admin' && member.status === 'active'
      && typeof member.email === 'string' && hash(member.email.trim().toLowerCase()) === ADMIN_HASH)
    if (admins.length === 1) matches.push(choice.id)
    check(admins.length <= 1, 'workspace_refused')
  }
  check(matches.length === 1, 'workspace_refused')
  const workspaceId = matches[0]
  const { candidateTaskIds } = await searchCandidates(client, { ownerId, workspaceId }, observeInventory)
  check(candidateTaskIds.length > 0, 'sample_missing')
  return { ownerId, workspaceId, candidateTaskIds }
}

export async function verifyScope(client, scope) {
  const session = await client.json('/api/auth/get-session')
  const workspace = await client.json('/api/workspace?workspace=' + scope.workspaceId)
  check(session?.user?.id === scope.ownerId && workspace.currentUserId === scope.ownerId
    && workspace.workspace?.id === scope.workspaceId && ['member', 'admin'].includes(workspace.role), 'sample_changed')
  // Exact IDs can be older than the newest list page. The existing request
  // preference is membership checked, and does not mutate the account's cookie.
  // Normal getIssue performs fresh authorization; no body, title or prompt enters the report.
  for (const id of scope.taskIds) {
    const value = await client.rpc('issues.getIssue', [id], { headers: { 'x-mikka-workspace-id': scope.workspaceId } }), issue = value?.issue
    check(issue?.id === id && issue.userId === scope.ownerId && issue.workspaceId === scope.workspaceId
      && issue.ownershipState === 'bound' && LABELS.has(issue.scope), 'sample_changed')
  }
}

// Constant SQL only. Parameters are the already frozen API UUIDs and owner.
// Raw execution definitions are hashed inside PostgreSQL, never transported.
export const SQL = Object.freeze({
  settings: `SELECT current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation`,
  ledger: `SELECT count(*) FILTER (WHERE name LIKE '202611091430%')::int AS epic,
    md5(coalesce(string_agg(name, E'\\n' ORDER BY name),'')) AS digest FROM schema_migrations`,
  binding: `WITH candidates AS (
    SELECT i.id, i."userId"=$2 AND coalesce(to_jsonb(i)->>'workspaceId','')=$3
      AND i.scope IN ('workspace','personal') AS matches_scope,
      EXISTS (SELECT 1 FROM run_publications p WHERE p."issueId"=i.id AND p.status='published') AS published,
      EXISTS (SELECT 1 FROM agent_runs r WHERE r."issueId"=i.id AND r.status IN ('succeeded','stopped','failed','cancelled')) AS ended
    FROM issues i WHERE i.id=ANY($1::uuid[])
    ) SELECT count(*)::int AS present, count(*) FILTER (WHERE matches_scope)::int AS "bound",
      count(*) FILTER (WHERE matches_scope AND published)::int AS published,
      count(*) FILTER (WHERE matches_scope AND ended)::int AS ended,
      count(*) FILTER (WHERE matches_scope AND published AND ended)::int AS historical FROM candidates`,
  select: `SELECT i.id FROM issues i WHERE i.id=ANY($1::uuid[]) AND i."userId"=$2
    AND coalesce(to_jsonb(i)->>'workspaceId','')=$3 AND i.scope IN ('workspace','personal')
    AND EXISTS (SELECT 1 FROM run_publications p WHERE p."issueId"=i.id AND p.status='published')
    AND EXISTS (SELECT 1 FROM agent_runs r WHERE r."issueId"=i.id AND r.status IN ('succeeded','stopped','failed','cancelled'))
    ORDER BY EXISTS (SELECT 1 FROM agent_runs r WHERE r."issueId"=i.id
      AND r.status IN ('succeeded','stopped','failed','cancelled') AND r."agentDefinition"->'projectExecution' IS NOT NULL) DESC,
      i.id LIMIT 10`,
  task: `SELECT id, "userId" AS owner, scope,
    coalesce(to_jsonb(i)->>'workspaceId','') AS workspace,
    coalesce(to_jsonb(i)->>'issuedIdentifier','') AS identifier
    FROM issues i WHERE id=ANY($1::uuid[]) ORDER BY id`,
  publication: `SELECT "runId" AS id, "issueId" AS "issueId", identifier, branch, "baseBranch" AS "baseBranch", "remoteKey" AS "remoteKey"
    FROM run_publications WHERE "issueId"=ANY($1::uuid[]) AND status='published' ORDER BY "runId" LIMIT 1001`,
  run: `SELECT id, "issueId" AS "issueId", "agentDefinition"->'projectExecution' IS NOT NULL AS "hasProjectSnapshot",
    md5(jsonb_build_object('agentDefinition',"agentDefinition",'baseBranch',"baseBranch")::text) AS "frozenDigest"
    FROM agent_runs WHERE "issueId"=ANY($1::uuid[]) AND status IN ('succeeded','stopped','failed','cancelled') ORDER BY id LIMIT 1001`,
})

export function projectRows(scope, rows) {
  check(Array.isArray(scope.taskIds) && scope.taskIds.length > 0 && scope.taskIds.length <= 10
    && scope.taskIds.every(id => UUID.test(id)) && new Set(scope.taskIds).size === scope.taskIds.length, 'sample_invalid')
  check(rows.task.length === scope.taskIds.length && rows.task.every(row => scope.taskIds.includes(row.id)
    && row.owner === scope.ownerId && row.workspace === scope.workspaceId && LABELS.has(row.scope))
    && new Set(rows.task.map(row => row.id)).size === scope.taskIds.length, 'database_binding')
  check(rows.publication.length > 0 && rows.run.length > 0, 'history_missing')
  for (const kind of ['publication', 'run']) {
    check(rows[kind].length <= 1000, 'sample_too_large')
    check(rows[kind].every(row => UUID.test(row.id) && scope.taskIds.includes(row.issueId))
      && new Set(rows[kind].map(row => row.id)).size === rows[kind].length, 'sample_invalid')
  }
  check(rows.run.every(row => typeof row.hasProjectSnapshot === 'boolean' && /^[a-f0-9]{32}$/.test(row.frozenDigest)), 'sample_invalid')
  const field = value => { check(value === null || typeof value === 'string' && value.length <= 8192, 'sample_invalid'); return hash(JSON.stringify(value)) }
  const result = {
    task: rows.task.map(row => ({ id: row.id, workspaceId: row.workspace,
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
    check(ledger?.epic === 0 && /^[a-f0-9]{32}$/.test(ledger.digest), 'migration_already_applied')
    observe({ lastReadStage: 'ledger_verified', ledgerDigest: ledger.digest, canonicalEpicMigrations: 0 })
    const binding = (await db.query(SQL.binding, [scope.candidateTaskIds, scope.ownerId, scope.workspaceId])).rows[0]
    const keys = ['present', 'bound', 'published', 'ended', 'historical']
    check(binding && keys.every(key => Number.isSafeInteger(binding[key]) && binding[key] >= 0 && binding[key] <= scope.candidateTaskIds.length), 'database_binding')
    const candidateCounts = Object.fromEntries(keys.map(key => [key, binding[key]]))
    observe({ lastReadStage: 'candidate_binding', candidateCounts })
    check(binding.present === scope.candidateTaskIds.length && binding.bound === scope.candidateTaskIds.length, 'database_binding')
    const selected = (await db.query(SQL.select, [scope.candidateTaskIds, scope.ownerId, scope.workspaceId])).rows
    observe({ lastReadStage: 'history_selection', selectedCount: selected.length })
    check(selected.length > 0, 'history_missing')
    check(selected.length <= 10 && selected.every(row => scope.candidateTaskIds.includes(row.id))
      && new Set(selected.map(row => row.id)).size === selected.length, 'sample_invalid')
    const taskIds = selected.map(row => row.id).sort()
    const rows = {}
    for (const kind of ['task', 'publication', 'run']) rows[kind] = (await db.query(SQL[kind], [taskIds])).rows
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
  const report = { version: 1, issue: 1687, batch: 1782, phase: 'before', status: 'incomplete',
    opsSource: env.GITHUB_SHA, mainSha: MAIN, runId: env.GITHUB_RUN_ID, runAttempt: 1,
    sourceSha256: hash(await readFile(new URL(import.meta.url))), before, startedAt: new Date().toISOString(),
    cleanup: { databaseConnectionClosed: false, transactionRolledBack: false, signedOut: false },
    scope: 'at_most_ten_existing_owned_tasks_authorized_by_normal_api',
    limitations: ['bounded_sample_not_all_history', 'api_database_entity_match_not_vercel_environment_inspection',
      'normal_api_read_maintenance_writes_not_measured', 'before_only_after_same_uuids_required'] }
  let pool, signedIn = false
  try {
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    signedIn = true; check(login.ok, 'account_refused')
    const scope = await selectScope(client, email, counts => { report.apiTaskInventory = counts })
    report.candidateCount = scope.candidateTaskIds.length
    report.workspaceId = scope.workspaceId
    report.ownerSha256 = hash(scope.ownerId)
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
