// One bounded read-only database statement per server-confirmed terminal.
// Production credentials are supplied only by the existing OIDC Actions job.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configuration } from './mcp-reply-production.mjs'

export const STATEMENT_SHA256 = 'cddb79788d85ed13c6b7df82adcd0f471f94bbba6fa73c6576ca1643c2907c6c'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const sha = value => createHash('sha256').update(value).digest('hex')
const need = (value, code) => { if (!value) throw Error('group_audit_' + code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export function terminalFor(artifact, runtime, row) {
  need(runtime?.sourceRunId === artifact.binding.runId && runtime.sourceSha === artifact.binding.applicationSha
    && /^dpl_[A-Za-z0-9]+$/.test(runtime.deploymentId ?? '') && Array.isArray(runtime.groups), 'runtime_source')
  const matches = runtime.groups.filter(value => value.conversationId === row.groupId && value.messageId === row.messageId)
  need(matches.length === 1, 'terminal_missing')
  const value = matches[0]
  need(value.event === 'group_turn_terminal' && Number.isSafeInteger(value.started) && value.started > 0
    && value.settled === value.started && Number.isSafeInteger(value.aborted) && value.aborted > 0
    && value.aborted <= value.started && value.sessionLost === false && Number.isSafeInteger(value.endedAt)
    && value.endedAt >= Date.parse(row.stop.requestedAt), 'terminal_incomplete')
  return value
}

export function databaseAuditPassed(a, row) {
  const zero = values => values.every(value => Number(value) === 0)
  if (!a?.scopeMatched || a.scope?.groupId !== row.groupId || a.scope.messageId !== row.messageId
    || a.membership?.intact !== true || a.turn?.status !== 'failed' || a.turn.isStopped !== true
    || a.turn.hasOtherError !== false || a.turn.traceStatus !== 'stopped' || a.turn.agentActive !== false
    || a.turn.botActive !== false || a.turn.activeRunId !== null || a.turn.nextDecisionAt !== null
    || !zero([a.activeSession?.locks, a.activeSession?.held, a.activeSession?.waiters])
    || Number(a.cancellationFeedbackCount) !== 1
    || !zero([a.trace?.delegateCount, a.trace?.taskEventCount, a.trace?.unknownEvents,
      a.delegation?.bindings, a.delegation?.receipts, a.private?.foreignScopeLinks, a.private?.invalidMemberships,
      a.private?.unexpectedAuthors, a.public?.otherUserRoots, a.public?.unexpectedAuthors, a.private?.otherAnchorLinks])
    || a.public?.rowsTruncated || a.private?.linksTruncated || a.private?.rowsTruncated || a.trace?.eventsTruncated) return false
  // Compare server records with the persisted stop boundary; the Actions
  // runner's wall clock is not the database's publication clock.
  const cutoff = Date.parse(a.turn.traceFinishedAt)
  if (!Number.isFinite(cutoff) || [...(a.public.rows ?? []), ...(a.private.rows ?? [])]
    .some(value => !Number.isFinite(Date.parse(value.createdAt)) || Date.parse(value.createdAt) > cutoff)) return false
  if (row.scenario === 'private') return Number(a.public.replyCount) === 0 && Number(a.trace.publicPublishCount) === 0
    && Number(a.private.linkCount) === 1 && Number(a.private.actualMessages) === 1 && Number(a.private.declaredMessages) === 1
    && Number(a.trace.privatePublishCount) === 1 && a.private.links[0]?.ownedScope === true
    && a.private.rows[0]?.authorFixture === 'lead'
  return zero([a.private.linkCount, a.private.actualMessages, a.private.declaredMessages, a.trace.privatePublishCount])
    && Number(a.public.totalGroupMessages) === Number(a.public.replyCount) + 1
    && Number(a.trace.publicPublishCount) === Number(a.public.replyCount)
}

export async function runGroupStopAudit(env, event, artifact, runtime) {
  configuration(env, event)
  const source = resolve(env.MIKKA_RELEASE_SOURCE)
  need(source.startsWith(resolve(env.GITHUB_WORKSPACE) + '/') && artifact?.issue === 1212
    && artifact.schemaVersion === 1 && UUID.test(artifact.workspaceId) && artifact.cases?.length <= 4, 'fixture_scope')
  const sql = await readFile(new URL('./group-stop-audit.sql', import.meta.url), 'utf8')
  need(sha(sql) === STATEMENT_SHA256, 'statement_hash')
  const { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const client = createSessionClient('https://app.aspectlylabs.com')
  const report = { sourceRunId: artifact.binding.runId, sourceSha: artifact.binding.applicationSha,
    deploymentId: runtime.deploymentId, status: 'failed', groups: [], cleanup: {} }
  let ownerId, original, pool
  try {
    const { email, password } = smokeAcceptanceAccount(env)
    await client.json('/api/auth/sign-in/email', post({ email, password }))
    const session = await client.json('/api/auth/get-session'); ownerId = session.user?.id
    need(typeof ownerId === 'string' && ownerId && session.user.email === email && sha(ownerId).slice(0, 16) === artifact.ownerRef, 'owner_scope')
    const scope = await selectAcceptanceTeam(client, { ownerId }, id => { original = id })
    need(scope.workspaceId === artifact.workspaceId, 'workspace_scope')
    const database = new URL(env.DATABASE_URL)
    need(database.protocol === 'postgresql:' || database.protocol === 'postgres:', 'database_protocol')
    need(database.hostname.endsWith('.neon.tech') && database.pathname === '/orvilo_mvp'
      && !database.hash && (!database.port || database.port === '5432'), 'database_target')
    const { Pool } = createRequire(source + '/package.json')('pg')
    pool = new Pool({ connectionString: database.href, max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 15000, query_timeout: 20000, options: '-c default_transaction_read_only=on',
      application_name: 'mikka-owned-group-acceptance-audit' })
    for (const row of artifact.cases.filter(row => row.groupId)) {
      const proof = { groupId: row.groupId, messageId: row.messageId, databaseSelectCount: 0,
        statementSha256: STATEMENT_SHA256, databaseAuditPassed: false, status: 'failed' }
      report.groups.push(proof)
      try {
        const terminal = terminalFor(artifact, runtime, row)
        need(UUID.test(row.groupId) && UUID.test(row.messageId) && row.botIds.length === 2
          && row.botIds.every(id => UUID.test(id) && artifact.bots.some(bot => bot.id === id))
          && row.title.startsWith('Issue1212 Stop ' + artifact.binding.runId + ' '), 'row_scope')
        Object.assign(proof, { serverTerminal: true, started: terminal.started, settled: terminal.settled,
          aborted: terminal.aborted, sessionLost: terminal.sessionLost, terminalReceiptSha256: sha(JSON.stringify(terminal)) })
        const db = await pool.connect()
        try {
          await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
          proof.databaseSelectCount++
          const result = await db.query(sql, [ownerId, scope.workspaceId, row.groupId, row.messageId, row.title, row.botIds])
          need(result.rowCount === 1, 'row_count'); proof.audit = result.rows[0].audit
          proof.databaseAuditPassed = databaseAuditPassed(proof.audit, row)
          need(proof.databaseAuditPassed, 'verdict')
          proof.status = 'passed'
        } finally { try { await db.query('ROLLBACK') } finally { db.release() } }
      } catch (error) { proof.code = /^group_audit_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'group_audit_failed' }
    }
    report.status = report.groups.length > 0 && report.groups.every(row => row.status === 'passed') ? 'passed' : 'failed'
  } catch { report.code = 'group_audit_scope_or_transport' }
  finally {
    await pool?.end()
    if (ownerId && original) { try { await restoreAcceptanceWorkspace(client, ownerId, original); report.cleanup.workspaceRestored = true } catch { report.cleanup.workspaceRestored = false; report.status = 'failed' } }
    try { await client.json('/api/auth/sign-out', post({})); report.cleanup.sessionClosed = true } catch { report.cleanup.sessionClosed = false; report.status = 'failed' }
    client.clear(); await mkdir('issue-1212-mcp-report', { recursive: true }); await writeFile('issue-1212-mcp-report/group-audit.json', JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const paths = [process.env.MIKKA_GROUP_REPORT, process.env.MIKKA_GROUP_TERMINALS]
    need(paths.every(path => /^scripts\/acceptance\/issue-1212-mcp\/receipts\/[a-z0-9-]+\.json$/.test(path ?? '')), 'input_path')
    const [artifact, runtime] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))))
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const report = await runGroupStopAudit(process.env, event, artifact, runtime)
    console.log(JSON.stringify(report)); if (report.status !== 'passed') process.exitCode = 1
  } catch { console.error('group_audit_configuration_failed'); process.exitCode = 1 }
}
