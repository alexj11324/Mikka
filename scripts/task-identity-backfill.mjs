/** Complete APP identities from the immutable WS alias snapshot after both
 * databases and task ownership have migrated, before admitting new readers.
 * Never rewrites an issued ID or any Run/publication receipt. Safe to resume.
 */
export async function backfillTaskIdentifiers(app, workspace, { batchSize = 200 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid task identity batch size')
  // APP DDL precedes P0's cross-database ownership backfill. Its historical
  // aliases may still have a NULL tenant, including on already-issued tasks.
  // Repair that projection and import trusted peer publication receipts before
  // choosing any new immutable identifier. A keyset makes retries bounded and
  // never rewrites a conflicting non-NULL tenant/owner or an issued spelling.
  let after = null, aliasTasks = 0, boundAliases = 0, publicationAliases = 0
  for (;;) {
    const { rows: tasks } = await app.query(`SELECT i.id FROM issues i
      WHERE i."ownershipState"='bound' AND i."workspaceId" IS NOT NULL
        AND ($1::uuid IS NULL OR i.id>$1) AND (
          EXISTS (SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id
            AND a."ownerId"=i."userId" AND a."workspaceId" IS NULL)
          OR EXISTS (SELECT 1 FROM run_publications p
            JOIN agent_runs r ON r.id=p."runId" AND r."issueId"=p."issueId" AND r."userId"=p."userId"
            WHERE p."issueId"=i.id AND r."workspaceId"=i."workspaceId"
              AND p.identifier IS NOT NULL AND p.identifier<>'' AND NOT EXISTS (
                SELECT 1 FROM task_identifier_aliases a WHERE a."issueId"=i.id
                  AND a.identifier=p.identifier AND a.kind='publication'))
        ) ORDER BY i.id LIMIT $2`, [after, batchSize])
    if (!tasks.length) break
    after = tasks.at(-1).id
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'")
      const { rows: [counts] } = await client.query('SELECT * FROM reconcile_bound_task_identifier_aliases($1::uuid[])', [tasks.map(task => task.id)])
      await client.query('COMMIT')
      aliasTasks += tasks.length
      boundAliases += Number(counts.bound_aliases)
      publicationAliases += Number(counts.publication_aliases)
      console.log(`migrate: task aliases tasks=${aliasTasks} bound=${boundAliases} publications=${publicationAliases}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
  let issued = 0
  for (;;) {
    const { rows: tasks } = await app.query(`SELECT id, "workspaceId", "userId" FROM issues
      WHERE "workspaceId" IS NOT NULL AND "issuedIdentifier" IS NULL ORDER BY id LIMIT $1`, [batchSize])
    if (!tasks.length) break
    const byId = new Map(tasks.map(task => [task.id, task]))
    const { rows: candidates } = await workspace.query(`SELECT "issueId", "workspaceId", "ownerId", identifier, "createdAt"
      FROM mikka_task_identifier_aliases WHERE "issueId"=ANY($1::uuid[]) ORDER BY "createdAt", identifier`, [tasks.map(task => task.id)])
    const aliases = candidates.filter(alias => {
      const task = byId.get(alias.issueId)
      return task?.workspaceId === alias.workspaceId && task.userId === alias.ownerId
    })
    const firstAlias = new Map()
    for (const alias of aliases) if (!firstAlias.has(alias.issueId)) firstAlias.set(alias.issueId, alias.identifier)
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'")
      if (aliases.length) await client.query(`INSERT INTO task_identifier_aliases ("issueId","workspaceId","ownerId",identifier,kind,"createdAt")
        SELECT a."issueId",a."workspaceId",a."ownerId",a.identifier,'team',a."createdAt"
        FROM jsonb_to_recordset($1::jsonb) AS a("issueId" uuid,"workspaceId" uuid,"ownerId" text,identifier text,"createdAt" timestamptz)
        JOIN issues i ON i.id=a."issueId" AND i."workspaceId"=a."workspaceId" AND i."userId"=a."ownerId"
        ON CONFLICT DO NOTHING`, [JSON.stringify(aliases)])
      const input = tasks.map(task => ({ id: task.id, alias: firstAlias.get(task.id) ?? null }))
      const { rows } = await client.query(`WITH ordered AS MATERIALIZED (
        SELECT id,alias FROM jsonb_to_recordset($1::jsonb) AS a(id uuid,alias text) ORDER BY id
      ) SELECT id,ensure_task_identifier(id,alias) AS identifier FROM ordered`, [JSON.stringify(input)])
      await client.query('COMMIT')
      issued += rows.filter(row => row.identifier !== null).length
      if (!rows.some(row => row.identifier !== null)) throw new Error('Task identity backfill made no progress')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
  return { issued }
}
