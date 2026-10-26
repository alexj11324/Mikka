// Read-only snapshot of the exact OAuth-attempt cleanup join in artifacts.go.
// This is an inventory, never an authorization or a deletion/resume operation.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const hash = /^[a-f0-9]{64}$/
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
const fail = () => { throw new Error('BYOS inventory refused: invalid or ambiguous scope, ownership, association, or budget') }

// Do not filter candidate ownership here: doing so would hide cross-scope rows
// affected by the production join, which matches attempts by secret name alone.
const query = `SELECT c.id AS "scopeConnectionId", c."ownerId" AS "scopeOwnerId",
 c."workspaceId" AS "scopeWorkspaceId", c.provider AS "scopeProvider", candidate.*
FROM byos_connections c
LEFT JOIN LATERAL (
 SELECT o."stateHash", o."connectionId" AS "attemptConnectionId",
  o."ownerId" AS "attemptOwnerId", o."workspaceId" AS "attemptWorkspaceId",
  o."operationId" AS "attemptOperationId", o."secretName",
  a.name AS "artifactName", a."connectionId" AS "artifactConnectionId",
  a."ownerId" AS "artifactOwnerId", a."workspaceId" AS "artifactWorkspaceId",
  a.provider AS "artifactProvider", a.kind AS "artifactKind",
  a."operationId" AS "artifactOperationId", a."deletedAt" AS "artifactDeletedAt"
 FROM byos_oauth_attempts o JOIN byos_secret_artifacts a ON o."secretName" = a.name
 WHERE a."connectionId" = c.id AND a."deletedAt" IS NOT NULL
) candidate ON true
WHERE c.id = $1
ORDER BY candidate."stateHash", candidate."artifactName"
LIMIT $2`

/** db must expose query(text, values); caller supplies one explicit scope/budget. */
export async function inventoryByosOAuthAttempts(db, scope, budget) {
  if (!db || typeof db.query !== 'function' || !scope ||
      Object.keys(scope).sort().join(',') !== 'connectionId,ownerId,provider,workspaceId' ||
      !uuid.test(scope.connectionId ?? '') || !nonempty(scope.ownerId) || !nonempty(scope.workspaceId) ||
      !['codex', 'claude'].includes(scope.provider) || !Number.isSafeInteger(budget) || budget < 0 || budget > 10000) fail()
  // Capture the scope before awaiting a caller-owned executor.
  const expected = { ...scope, connectionId: scope.connectionId.toLowerCase() }
  const result = await db.query(query, [expected.connectionId, budget + 1])
  if (!Array.isArray(result?.rows) || !result.rows.length) fail()
  const rows = [], keys = new Set(), artifacts = new Set()
  for (const row of result.rows) {
    if (!row || row.scopeConnectionId !== expected.connectionId || row.scopeOwnerId !== expected.ownerId ||
        row.scopeWorkspaceId !== expected.workspaceId || row.scopeProvider !== expected.provider) fail()
    if (row.stateHash === null) {
      if (result.rows.length !== 1 || ['attemptConnectionId', 'attemptOwnerId', 'attemptWorkspaceId',
        'attemptOperationId', 'secretName', 'artifactName', 'artifactConnectionId', 'artifactOwnerId',
        'artifactWorkspaceId', 'artifactProvider', 'artifactKind', 'artifactOperationId', 'artifactDeletedAt']
        .some(key => row[key] !== null)) fail()
      continue
    }
    if (!hash.test(row.stateHash ?? '') || keys.has(row.stateHash) || artifacts.has(row.artifactName) ||
        row.attemptConnectionId !== expected.connectionId || row.artifactConnectionId !== expected.connectionId ||
        row.attemptOwnerId !== expected.ownerId || row.artifactOwnerId !== expected.ownerId ||
        row.attemptWorkspaceId !== expected.workspaceId || row.artifactWorkspaceId !== expected.workspaceId ||
        row.artifactProvider !== expected.provider || row.artifactKind !== 'oauth' ||
        !uuid.test(row.attemptOperationId ?? '') || row.attemptOperationId !== row.artifactOperationId ||
        !/^mikka-byos-[a-f0-9-]{36}$/.test(row.artifactName ?? '') || row.secretName !== row.artifactName ||
        row.artifactDeletedAt == null || !Number.isFinite(new Date(row.artifactDeletedAt).getTime())) fail()
    keys.add(row.stateHash); artifacts.add(row.artifactName)
    rows.push({ primaryKey: { stateHash: row.stateHash }, connectionId: expected.connectionId,
      ownerId: expected.ownerId, workspaceId: expected.workspaceId, operationId: row.attemptOperationId,
      secretArtifact: { name: row.artifactName, connectionId: row.artifactConnectionId,
        ownerId: row.artifactOwnerId, workspaceId: row.artifactWorkspaceId, provider: row.artifactProvider,
        kind: row.artifactKind, operationId: row.artifactOperationId,
        deletedAt: new Date(row.artifactDeletedAt).toISOString() } })
    if (rows.length > budget) fail()
  }
  return { table: 'byos_oauth_attempts', scope: expected, budget, count: rows.length, rows }
}
