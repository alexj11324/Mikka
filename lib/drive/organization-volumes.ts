import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { withOrganizationDriveRead, type OrganizationDriveProject } from './organization-read'
import type { DriveScope } from './contract'
import { listOrganizationVolumeSkills } from './skills'
import { organizationVolumeSelect, serializeOrganizationVolume, type OrganizationVolumeRow } from './volumes'
export type { OrganizationDriveVolume } from './volumes'

const optionalId = z.string().min(1).max(200).optional()
const scopeDirectoryQuery = z.object({
  projectId: z.uuid().optional(), automationId: optionalId, page: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
}).strict()
const volumeListQuery = z.object({
  projectId: z.uuid().optional(), userId: optionalId, automationId: optionalId, captainJamId: optionalId,
  exactScope: z.literal('true').optional(), archived: z.enum(['true', 'false']).optional(),
}).strict()

function query(search: URLSearchParams) {
  const fields = Object.fromEntries(search)
  if (Object.keys(fields).length !== search.size) throw new z.ZodError([{ code: 'custom', path: [], message: 'Repeated Drive filter' }])
  return fields
}

async function readableProjects(workspaces: string[], reader: string, projectId?: string) {
  const result = await pool.query<OrganizationDriveProject>(`SELECT id,"workspaceId" FROM resource_access_policies
    WHERE kind='project' AND "workspaceId"=ANY($1::uuid[]) AND ($3::uuid IS NULL OR id=$3)
      AND mikka_resource_acl_allowed('account',$2,"workspaceId",kind,id,'canReadContent')`, [workspaces, reader, projectId ?? null])
  return result.rows
}

// Every row describes an existing Drive scope in an admitted tenant. Recheck the
// final Project ACL inside the same APP snapshot that reads its volumes and totals.
const scopedVolumes = `WITH project_scopes AS MATERIALIZED (
    SELECT p.id,p.workspace_id FROM unnest($3::uuid[],$4::uuid[]) p(id,workspace_id)
    WHERE mikka_resource_acl_allowed('account',$2,p.workspace_id,'project',p.id,'canReadContent')
  ), scopes AS MATERIALIZED (
    SELECT w.id AS workspace_id,x.kind AS scope,NULL::uuid AS project_id,x.person AS user_id,
      CASE WHEN x.kind='user' THEN $2 ELSE w.id::text END AS scope_id,
      CASE WHEN x.kind='user' THEN $2 ELSE 'drive-team:'||w.id::text END AS owner_id
    FROM unnest($1::uuid[]) w(id) CROSS JOIN (VALUES ('team-workspace',NULL::text),('user',$2::text)) x(kind,person)
    UNION ALL
    SELECT p.workspace_id,x.kind,p.id,x.person,p.id::text,
      CASE WHEN x.kind='project-user' THEN $2 ELSE 'drive-project:'||p.workspace_id::text||':'||p.id::text END
    FROM project_scopes p CROSS JOIN (VALUES ('project',NULL::text),('project-user',$2::text)) x(kind,person)
  ), selected_scopes AS MATERIALIZED (
    SELECT * FROM scopes WHERE ($5::uuid IS NULL OR project_id=$5) AND ($6::text IS NULL OR user_id=$6)
      AND (NOT $7::boolean OR ((project_id IS NULL)=($5::uuid IS NULL) AND (user_id IS NULL)=($6::text IS NULL)))
  ), volumes AS MATERIALIZED (
    ${organizationVolumeSelect}
    JOIN selected_scopes s ON v."workspaceId"=s.workspace_id AND v."driveScope"=s.scope
      AND v."scopeId"=s.scope_id AND v."ownerId"=s.owner_id
      AND v."scopeUserId" IS NOT DISTINCT FROM (CASE WHEN s.scope='project-user' THEN s.user_id END)
    WHERE (v."archivedAt" IS NOT NULL)=$8::boolean
  )`

function scopeParams(workspaces: string[], reader: string, projects: OrganizationDriveProject[], projectId?: string, userId?: string, exact = false, archived = false) {
  return [workspaces, reader, projects.map(p => p.id), projects.map(p => p.workspaceId), projectId ?? null, userId ?? null, exact, archived]
}

export function listOrganizationDriveVolumes(organizationId: string, reader: string, sessionId: string, search: URLSearchParams) {
  const filters = volumeListQuery.parse(query(search))
  const unsupported = !!(filters.automationId || filters.captainJamId || filters.userId && filters.userId !== reader)
  return withOrganizationDriveRead(organizationId, reader, sessionId,
    (ws, actor) => unsupported || filters.exactScope && !filters.projectId ? Promise.resolve([]) : readableProjects(ws, actor, filters.projectId),
    async (app, workspaces, projects) => {
      if (unsupported) return []
      const result = await app.query<OrganizationVolumeRow>(`${scopedVolumes} SELECT * FROM volumes ORDER BY "headUpdatedAt" DESC,id`,
        scopeParams(workspaces, reader, projects, filters.projectId, filters.userId, !!filters.exactScope, filters.archived === 'true'))
      return result.rows.map(serializeOrganizationVolume)
    })
}

/** The skills selector uses the same authorized active volumes as the Files
 * catalog and returns only the declared Markdown metadata. */
export function listOrganizationDriveSkills(organizationId: string, reader: string, sessionId: string, search: URLSearchParams, signal: AbortSignal) {
  const { projectId } = z.object({ projectId: z.uuid().optional() }).strict().parse(query(search))
  return withOrganizationDriveRead(organizationId, reader, sessionId,
    (workspaces, actor) => readableProjects(workspaces, actor, projectId),
    async (app, workspaces, projects) => {
      const volumes = await app.query<{ id: string }>(`${scopedVolumes} SELECT id FROM volumes`, scopeParams(workspaces, reader, projects, projectId))
      return listOrganizationVolumeSkills(app, volumes.rows.map(v => v.id), signal)
    })
}

export type OrganizationDriveScopePage = {
  storage: null
  items: { driveScope: DriveScope; projectId: string | null; userId: string | null; automationId: null;
    fileCount: number; totalBytes: number; headUpdatedAt: string | null }[]
  page: number; pageCount: number; totalScopes: number
}

export function organizationDriveScopeDirectory(organizationId: string, reader: string, sessionId: string, search: URLSearchParams) {
  const filters = scopeDirectoryQuery.parse(query(search))
  return withOrganizationDriveRead(organizationId, reader, sessionId,
    (ws, actor) => filters.automationId ? Promise.resolve([]) : readableProjects(ws, actor, filters.projectId),
    async (app, workspaces, projects) => {
      if (filters.automationId) return { storage: null, items: [], page: 1, pageCount: 1, totalScopes: 0 }
      // In the Organization client a scope is addressed by Project and person.
      // Sum its admitted Workspaces before paging so selecting the row returns the same volumes.
      const result = await app.query<Omit<OrganizationDriveScopePage,'storage'>>(`${scopedVolumes}, grouped AS (
          SELECT s.scope AS "driveScope",s.project_id AS "projectId",s.user_id AS "userId",
            NULL::text AS "automationId",coalesce(sum(v."fileCount"),0)::float8 AS "fileCount",
            coalesce(sum(v."totalBytes"),0)::float8 AS "totalBytes",max(v."headUpdatedAt") AS "headUpdatedAt"
          FROM selected_scopes s LEFT JOIN volumes v ON v."workspaceId"=s.workspace_id AND v."driveScope"=s.scope
            AND v."projectId" IS NOT DISTINCT FROM s.project_id::text AND v."userId" IS NOT DISTINCT FROM s.user_id
          GROUP BY s.scope,s.project_id,s.user_id
        ), tally AS (
          SELECT count(*)::integer AS "totalScopes",greatest(1,ceil(count(*)::numeric/50)::integer) AS "pageCount" FROM grouped
        ), selected AS (
          SELECT *,least($9::integer,"pageCount") AS page FROM tally
        ), batch AS (
          SELECT * FROM grouped ORDER BY "driveScope","projectId" NULLS FIRST,"userId" NULLS FIRST
          LIMIT 50 OFFSET (SELECT (page-1)::bigint*50 FROM selected)
        ) SELECT selected.*,coalesce((SELECT jsonb_agg(batch ORDER BY "driveScope","projectId" NULLS FIRST,"userId" NULLS FIRST) FROM batch),'[]'::jsonb) AS items
        FROM selected`, [...scopeParams(workspaces, reader, projects, filters.projectId), filters.page])
      // Self-hosted Drive has no persisted Organization storage allowance or tier.
      return { ...result.rows[0], storage: null }
    })
}
