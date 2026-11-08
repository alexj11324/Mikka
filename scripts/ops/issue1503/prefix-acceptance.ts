/** #1492 production regression: two real owners' prefixes around one normal list request. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pool } from '../../../lib/db'
import { workspacePool } from '../../../lib/workspace-db'
import { ownerIssueListsChanged } from '../../../lib/live/lists'
import { normalizePersonalPrefix, prefixCollides } from '../../../lib/task-identifier'
import { smokeSession, SMOKE_ID, OWNER_ID, fail } from './http'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const OWNERS = [OWNER_ID, SMOKE_ID]
const emailHash = (value: unknown) => typeof value === 'string' ? createHash('sha256').update(value, 'utf8').digest('hex') : null
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type PrefixRow = { userId: string; prefix: string; updatedAt: string }
type OwnerRow = { id: string; email: string; keys: string[] | null }
type DeliveryTargetRow = { id: string; userId: string; scope: string; delivered: boolean }
type TaskNumberRow = { issueId: string; number: number | string; identifier: string }
const inserted: PrefixRow[] = []
let before: PrefixRow[] | undefined
let session: Awaited<ReturnType<typeof smokeSession>> | undefined
let stage = 'configuration'
const report: Record<string, any> = { issue: 1503, regression: 1492, phase: 'prefix_acceptance',
  startedAt: new Date().toISOString(), status: 'running', normalListRequests: 0 }
const safeCode = (error: unknown) => error instanceof Error && /^issue1503_[a-z0-9_]+$/.test(error.message)
  ? error.message : 'issue1503_prefix_acceptance_failed'
const readPrefixes = async () => (await pool.query<PrefixRow>(
  'SELECT "userId",prefix,"updatedAt"::text AS "updatedAt" FROM issue_prefixes WHERE "userId"=ANY($1::text[]) ORDER BY "userId"', [OWNERS])).rows
const same = (a: PrefixRow | undefined, b: PrefixRow | undefined) =>
  a === undefined ? b === undefined : b !== undefined && a.prefix === b.prefix && a.updatedAt === b.updatedAt

async function restoreInserted() {
  if (!inserted.length) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '2s'")
    await client.query("SET LOCAL statement_timeout = '10s'")
    let removed = 0
    for (const row of inserted) {
      const gone = await client.query(`DELETE FROM issue_prefixes
        WHERE "userId"=$1 AND prefix=$2 AND "updatedAt"=$3::timestamptz RETURNING "userId"`, [row.userId, row.prefix, row.updatedAt])
      if (gone.rowCount) { removed++; await ownerIssueListsChanged(client, row.userId) }
    }
    await client.query('COMMIT')
    report.removedFixtureRows = removed
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
  finally { client.release() }
}

try {
  const expectedSha = process.env.MIKKA_EXPECTED_DEPLOYMENT_SHA
  const ids: unknown = JSON.parse(process.env.MIKKA_1503_EXPECTED_ISSUE_IDS_JSON ?? 'null')
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !Array.isArray(ids) || ids.length !== 2
    || ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== 2) fail('prefix_configuration_required')
  const fixture = JSON.parse(await readFile(process.env.MIKKA_1503_FIXTURE_STATE_FILE ?? 'scripts/ops/issue1503/fixture-state.json', 'utf8'))
  if (fixture.issue !== 1503 || fixture.workspaceId !== WORKSPACE_ID || fixture.ownerUserId !== OWNER_ID || fixture.smokeUserId !== SMOKE_ID)
    fail('prefix_fixture_scope_mismatch')

  // Login, build, identities, access, completed delivery and original settings are checked before any temporary row exists.
  stage = 'preflight'
  session = await smokeSession()
  if ((await session.json('/api/version')).build !== expectedSha) fail('prefix_deployment_changed')
  report.productionBuild = expectedSha
  const owners = (await pool.query<OwnerRow>(`SELECT u.id,u.email,
    (SELECT array_agg(s."linearTeamKey") FROM linear_team_syncs s WHERE s."ownerId"=u.id) AS keys
    FROM "user" u WHERE u.id=ANY($1::text[])`, [OWNERS])).rows
  if (owners.length !== 2 || emailHash(owners.find(owner => owner.id === OWNER_ID)?.email) !== 'c6032681fcca35e9a45d042dc67def8773bf58b68cc42392d2ce643c79765a42'
    || emailHash(owners.find(owner => owner.id === SMOKE_ID)?.email) !== 'a20ddbf2c101381c3de802e5e546365caf46bc80b69f3526cd967331cf9bb20d')
    fail('prefix_existing_owner_identity_mismatch')
  const { rows: [workspace] } = await workspacePool.query(`SELECT w.id FROM mikka_workspaces w
    WHERE w.id=$1 AND w."userId"=$2 AND w.kind='team' AND w.slug='issue-1503-factory-smoke-20261106'
      AND (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id
        AND m."userId"=ANY($3::text[]) AND m.status='active')=2`, [WORKSPACE_ID, SMOKE_ID, OWNERS])
  if (!workspace) fail('prefix_workspace_access_mismatch')
  const targets = (await pool.query<DeliveryTargetRow>(`SELECT i.id,i."userId",i.scope,
    EXISTS(SELECT 1 FROM factory_tasks f JOIN factory_merges m ON m."taskId"=f.id AND m."candidateId"=f."candidateId"
      WHERE f."issueId"=i.id AND f."userId"=$2 AND f.stage='publish' AND f.status='passed'
        AND m.status='merged' AND m."mergeCommitSha" IS NOT NULL) AS delivered
    FROM issues i WHERE i.id=ANY($1::uuid[])`, [ids, SMOKE_ID])).rows
  // Task numbers and teams belong to the workspace database, not the application database.
  const numberRows = (await workspacePool.query<TaskNumberRow>(`SELECT l."issueId",l.number,t.identifier
    FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"
    WHERE l."issueId"=ANY($1::uuid[]) AND l."workspaceId"=$2`, [ids, WORKSPACE_ID])).rows
  const numberByIssue = new Map(numberRows.map(row => [row.issueId, row]))
  if (targets.length !== 2 || numberRows.length !== 2 || numberByIssue.size !== 2
    || targets.some(target => {
      const number = numberByIssue.get(target.id)
      return target.userId !== SMOKE_ID || target.scope !== 'workspace' || !target.delivered
        || number?.identifier !== 'F1503' || !/^[1-9][0-9]*$/.test(String(number?.number))
    })) fail('prefix_completed_delivery_targets_required')
  const expected = new Map(targets.map(target => {
    const number = numberByIssue.get(target.id)!
    return [target.id, `${number.identifier}-${number.number}`]
  }))
  before = await readPrefixes()
  for (const row of before) {
    if (normalizePersonalPrefix(row.prefix) !== row.prefix || prefixCollides(row.prefix, owners.find(owner => owner.id === row.userId)!.keys ?? []))
      fail('prefix_existing_configuration_unusable')
  }
  report.existingOwnerPrefixRows = before.length

  let list: unknown
  let windowStarted: number | undefined
  try {
    stage = 'insert_missing_fixture_prefixes'
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '2s'")
      await client.query("SET LOCAL statement_timeout = '10s'")
      for (const [index, ownerId] of OWNERS.entries()) {
        if (before.some(row => row.userId === ownerId)) continue
        const keys = owners.find(owner => owner.id === ownerId)!.keys ?? []
        const choices = Array.from({ length: 26 }, (_, i) => `TST${String.fromCharCode(65 + (i + index) % 26)}`)
        const prefix = choices.find(value => !prefixCollides(value, keys) && !inserted.some(row => row.prefix === value))
        if (!prefix) fail('prefix_nonconflicting_fixture_unavailable')
        const created = await client.query<PrefixRow>(`INSERT INTO issue_prefixes ("userId",prefix,"updatedAt")
          VALUES ($1,$2,clock_timestamp()) ON CONFLICT ("userId") DO NOTHING
          RETURNING "userId",prefix,"updatedAt"::text AS "updatedAt"`, [ownerId, prefix])
        // Exact timestamps remain PostgreSQL text, preserving microseconds for conditional cleanup.
        inserted.push(...created.rows)
        if (created.rowCount) await ownerIssueListsChanged(client, ownerId)
      }
      const current = (await client.query(`SELECT p."userId",p.prefix,
        EXISTS(SELECT 1 FROM linear_team_syncs s WHERE s."ownerId"=p."userId" AND upper(s."linearTeamKey")=upper(p.prefix)) AS collision
        FROM issue_prefixes p WHERE p."userId"=ANY($1::text[])`, [OWNERS])).rows
      if (current.length !== 2 || current.some(row => row.collision || normalizePersonalPrefix(row.prefix) !== row.prefix))
        fail('prefix_two_owner_fixture_not_ready')
      report.ownerPrefixRowsDuringRequest = current.length
      report.insertedFixtureRows = inserted.length
      // Durable safe cleanup metadata is written before COMMIT, outside the visible prefix window.
      await mkdir('issue1503-report', { recursive: true })
      await writeFile('issue1503-report/prefix-fixture-state.json', JSON.stringify({ issue: 1503, inserted }, null, 2) + '\n', { mode: 0o600 })
      await client.query('COMMIT')
      windowStarted = Date.now()
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }

    stage = 'normal_workspace_issue_list'
    report.normalListRequests++
    list = await session.rpc('issues.listWorkspaceIssues', [WORKSPACE_ID])
  } finally {
    // No second list request, sign-in, build lookup or result inspection extends this window.
    await restoreInserted()
    if (windowStarted !== undefined) report.temporaryPrefixWindowMs = Date.now() - windowStarted
  }

  stage = 'verify_normal_api_result'
  if (!Array.isArray(list)) fail('prefix_normal_list_shape_invalid')
  const observed = list.filter(item => expected.has(item?.id))
  if (observed.length !== 2 || new Set(observed.map(item => item.id)).size !== 2
    || observed.some(item => item.identifier !== expected.get(item.id))) fail('prefix_target_identifiers_mismatch')
  report.listRows = list.length
  report.targets = observed.map(item => ({ identifier: item.identifier, matchesExpected: true }))
  if ((await session.json('/api/version')).build !== expectedSha) fail('prefix_deployment_changed')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.code = safeCode(error)
  const causeCode = (error as any)?.code ?? (error as any)?.cause?.code
  if (typeof causeCode === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(causeCode)) report.causeCode = causeCode
  process.exitCode = 1
} finally {
  report.stage = stage
  try {
    // A failed cleanup gets one explicit recovery attempt, still guarded by all three exact fixture fields.
    if (inserted.length && report.removedFixtureRows === undefined) await restoreInserted()
    if (before) {
      const after = await readPrefixes()
      const originalRestored = OWNERS.every(id => same(before!.find(row => row.userId === id), after.find(row => row.userId === id)))
      const fixtureRowsRemaining = after.filter(row => inserted.some(created => created.userId === row.userId && same(created, row))).length
      report.restoration = { originalConfigurationRestored: originalRestored, fixtureRowsRemaining,
        concurrentChangePreserved: !originalRestored && fixtureRowsRemaining === 0 }
      if (fixtureRowsRemaining || !originalRestored) { report.status = 'failed'; process.exitCode = 1 }
    }
  } catch (error) { report.restoration = { verified: false, code: safeCode(error) }; report.status = 'failed'; process.exitCode = 1 }
  if (session) await session.close().catch(() => undefined)
  await Promise.allSettled([pool.end(), workspacePool.end()])
  report.completedAt = new Date().toISOString()
  await mkdir('issue1503-report', { recursive: true })
  await writeFile('issue1503-report/prefix-acceptance.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
}
