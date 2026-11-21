// Account deletion owns its subscriptions and the solo Workspaces in its frozen
// plan. That plan is in the application database even on split installations.
export const ORDINARY_CLEANUP_SQL = `NOT EXISTS (SELECT 1 FROM account_deletion_jobs deletion
  WHERE deletion.stage NOT IN ('completed','cancelled')
    AND (deletion."subjectUserId"=c."ownerId" OR (deletion.plan->'solo') ? lower(c."workspaceId")))`

export const ARTIFACT_CLEANUP_SQL = `FROM byos_secret_artifacts a JOIN byos_connections c ON c.id=a."connectionId"
  WHERE a."deletedAt" IS NULL AND (a."publishedAt" IS NOT NULL OR a."notBefore"<=now())
    AND a.name NOT IN (coalesce(c."secretName",''),coalesce(c."accessSecretName",''),coalesce(c."stagedSecretName",''),coalesce(c."stagedAccessName",''))
    AND ${ORDINARY_CLEANUP_SQL}`
