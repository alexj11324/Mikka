import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { enterpriseAccessAllowed } from '@/lib/enterprise/access-policy'
import { lockEnterpriseOrganizationRead } from '@/lib/enterprise/live-store'
import { enterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { projectRepositoryKey, projectBranch } from '@/lib/project-resources/contracts'
import { checkExpiry } from '@/lib/tokens/format'
import { workspaceDb } from '@/lib/workspace-db'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { GovernanceError } from './errors'
import { requireOrganizationAdmin } from './organizations'
import { recordServiceIdentityChange, withServiceIdentityAdmin } from './service-identities'

const credentialInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rotate'), revision: z.number().int().positive(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(), organizationId: z.uuid().toLowerCase().optional() }).strict(),
  z.object({ action: z.literal('revoke'), revision: z.number().int().positive() }).strict(),
])
type CredentialState = { enabled: boolean; revision: number; configured: boolean; expiresAt: string | Date | null }
const stateColumns = sql`enabled,revision,"credentialHash" IS NOT NULL AS configured,"credentialExpiresAt" AS "expiresAt"`
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

export function manageServiceCredential(workspaceId: string, actor: EnterpriseReader, rawId: string, input?: unknown) {
  const id = z.uuid().parse(rawId)
  const change = input === undefined ? undefined : credentialInput.parse(input)
  // A human's existing PAT must not mint an independent, longer-lived machine credential.
  if (change?.action === 'rotate' && actor[enterprisePrincipal]?.kind !== 'session') throw new GovernanceError('access_denied')
  return withServiceIdentityAdmin(workspaceId, actor, async (workspace, actorName) => {
    const { rows: [state] } = await workspace.execute<CredentialState>(sql`SELECT ${stateColumns} FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND id=${id}::uuid FOR UPDATE`)
    if (!state) throw new GovernanceError('not_found')
    if (!change) {
      const { rows: [binding] } = await workspace.execute<{ organizationId: string }>(sql`SELECT b."organizationId"
        FROM mikka_service_key_organization_bindings b JOIN mikka_workspace_service_identities i
          ON i.id=b."identityId" AND i."workspaceId"=b."workspaceId" AND i."credentialHash"=b."credentialHash"
        WHERE i.id=${id}::uuid AND i."workspaceId"=${workspaceId}::uuid`)
      return binding ? { ...state, organizationId: binding.organizationId } : state
    }
    if (state.revision !== change.revision) throw new GovernanceError('service_identity_changed')
    if (change.action === 'revoke' && !state.configured) return state
    if (change.action === 'rotate' && !state.enabled) throw new GovernanceError('service_identity_disabled')
    let expiry: Date | null = null
    const organizationId = change.action === 'rotate' ? change.organizationId : undefined
    if (change.action === 'rotate') {
      try { expiry = checkExpiry(change.expiresAt, new Date()) } catch (cause) { throw new GovernanceError('invalid_request', cause) }
      if (organizationId) await requireOrganizationAdmin(workspace, organizationId, actor.id)
      const link = await organizationLink(workspace, workspaceId)
      if (organizationId && link?.organizationId !== organizationId) throw new GovernanceError('access_denied')
      if (link && (link.archived || !await writeTransaction(pool, app => serviceOrganizationAllowed(app, link.organizationId))))
        throw new GovernanceError('access_denied')
    }
    // The scoped format cannot authenticate on an older server that only recognizes the Workspace format.
    const prefix = organizationId ? 'mksvc_org_' : 'mksvc_'
    const token = change.action === 'rotate' ? prefix + randomBytes(32).toString('base64url') : null
    const hash = token && digest(token)
    const { rows: [updated] } = await workspace.execute<CredentialState>(sql`UPDATE mikka_workspace_service_identities
      SET "credentialHash"=${hash}, "credentialExpiresAt"=${expiry?.toISOString() ?? null}::timestamptz, revision=revision+1
      WHERE "workspaceId"=${workspaceId}::uuid AND id=${id}::uuid RETURNING ${stateColumns}`)
    // Update the canonical hash first so removal of the previous scope cannot invalidate its replacement.
    await workspace.execute(sql`DELETE FROM mikka_service_key_organization_bindings WHERE "identityId"=${id}::uuid`)
    if (organizationId) await workspace.execute(sql`INSERT INTO mikka_service_key_organization_bindings
      ("identityId","workspaceId","organizationId","credentialHash") VALUES
      (${id}::uuid,${workspaceId}::uuid,${organizationId}::uuid,${hash})`)
    await recordServiceIdentityChange(workspace, { id, workspaceId }, actor.id, actorName, token ? 'credential_rotated' : 'credential_revoked', organizationId)
    return token ? { ...updated, ...(organizationId && { organizationId }), token } : updated
  })
}

async function organizationLink(workspace: WorkspaceTransaction, workspaceId: string) {
  const { rows: [link] } = await workspace.execute<{ organizationId: string; archived: boolean }>(sql`SELECT l."organizationId",o."archivedAt" IS NOT NULL AS archived
    FROM mikka_organization_workspaces l JOIN mikka_organizations o ON o.id=l."organizationId"
    WHERE l."workspaceId"=${workspaceId}::uuid FOR SHARE OF l,o`)
  return link
}

async function serviceOrganizationAllowed(tx: PoolClient, organizationId: string) {
  await lockEnterpriseOrganizationRead(tx, organizationId)
  const { rows: [policy] } = await tx.query<{ enforceSso: boolean; allowMachineCredentials: boolean; archived: boolean }>(
    'SELECT "enforceSso","allowMachineCredentials","archivedAt" IS NOT NULL AS archived FROM enterprise_org_policy WHERE "organizationId"=$1',
    [organizationId],
  )
  return enterpriseAccessAllowed({
    enforceSso: policy?.enforceSso ?? false, allowMachineCredentials: policy?.allowMachineCredentials ?? false,
    managedRevoked: policy?.archived ?? false, credentialValid: true, sessionAssured: false, breakGlass: false,
  }, { kind: 'service' })
}

/** The bearer proves only this nonhuman principal. The existing SQL ACL checks its
 * explicit Project grant, expiry and every ancestor on each bounded read. */
type ProjectRead = { after: string | null } | { projectId: string }

export async function readServiceCredentialProjects(header: string | null, read: ProjectRead) {
  const bearer = /^Bearer (mksvc_(org_)?[A-Za-z0-9_-]{43})$/.exec(header ?? '')
  if (!bearer) return null
  const [, token, organizationBound] = bearer
  const cursor = 'after' in read ? z.uuid().nullable().parse(read.after) : null
  const projectId = 'projectId' in read ? z.uuid().parse(read.projectId) : null
  const hash = digest(token)
  return workspaceDb.transaction(async workspace => {
    const { rows: [candidate] } = await workspace.execute<{ id: string; workspaceId: string }>(sql`SELECT id,"workspaceId" FROM mikka_workspace_service_identities
      WHERE "credentialHash"=${hash}`)
    if (!candidate) return null
    // Follow the existing Workspace-before-APP lock order throughout the read.
    const { workspaceId, id } = candidate
    const { rows: [tenant] } = await workspace.execute(sql`SELECT id FROM mikka_workspaces WHERE id=${workspaceId}::uuid AND kind='team' FOR SHARE`)
    if (!tenant) return null
    const { rows: [valid] } = await workspace.execute(sql`SELECT id FROM mikka_workspace_service_identities WHERE id=${id}::uuid
      AND "workspaceId"=${workspaceId}::uuid AND "credentialHash"=${hash} AND enabled
      AND ("credentialExpiresAt" IS NULL OR "credentialExpiresAt">clock_timestamp()) FOR SHARE`)
    if (!valid) return null
    const link = await organizationLink(workspace, workspaceId)
    if (link?.archived) return null
    if (organizationBound) {
      if (!link) return null
      const binding = await workspace.execute(sql`SELECT 1 FROM mikka_service_key_organization_bindings
        WHERE "identityId"=${id}::uuid AND "workspaceId"=${workspaceId}::uuid
          AND "organizationId"=${link.organizationId}::uuid AND "credentialHash"=${hash} FOR SHARE`)
      if (!binding.rowCount) return null
    }
    return writeTransaction(pool, async app => {
      if (link && !await serviceOrganizationAllowed(app, link.organizationId)) return null
      const { rows } = await app.query<{ id: string; visibility: string }>(`SELECT p.id,p.visibility FROM resource_access_policies p
        JOIN resource_access_grants g ON g."resourceKind"=p.kind AND g."resourceId"=p.id
        WHERE p."workspaceId"=$1 AND p.kind='project' AND g."subjectKind"='service' AND g."subjectId"=$2
          AND ($3::uuid IS NULL OR p.id>$3::uuid) AND ($4::uuid IS NULL OR p.id=$4::uuid)
          AND mikka_resource_acl_allowed('service',$2,$1,'project',p.id,'canReadContent')
        ORDER BY p.id LIMIT 101`, [workspaceId, id, cursor, projectId])
      if (projectId) {
        if (!rows.length) throw new GovernanceError('not_found')
        const { rows: [project] } = await workspace.execute<{
          id: string; name: string; description: string; createdAt: string | Date; updatedAt: string | Date
        }>(sql`SELECT id,name,description,"createdAt","updatedAt" FROM workspace_projects
          WHERE id=${projectId}::uuid AND "workspaceId"=${workspaceId}::uuid AND "archivedAt" IS NULL`)
        if (!project) throw new GovernanceError('not_found')
        const { rows: repositories } = await workspace.execute<{
          repositoryKey: string; baseBranch: string | null; isPrimary: boolean
        }>(sql`SELECT "repositoryKey","baseBranch","isPrimary" FROM workspace_project_repositories
          WHERE "projectId"=${projectId}::uuid AND "workspaceId"=${workspaceId}::uuid
          ORDER BY "isPrimary" DESC,"repositoryKey"`)
        const publicRepositories = repositories.flatMap(repo => {
          const key = projectRepositoryKey.safeParse(repo.repositoryKey)
          if (!key.success || key.data.startsWith('v2/file/')) return []
          const branch = projectBranch.safeParse(repo.baseBranch)
          return [{ repositoryKey: key.data, baseBranch: branch.success ? branch.data : null, isPrimary: repo.isPrimary }]
        })
        return {
          ...project,
          createdAt: new Date(project.createdAt).toISOString(), updatedAt: new Date(project.updatedAt).toISOString(),
          visibility: rows[0].visibility, repositories: publicRepositories,
        }
      }
      const page = rows.slice(0, 100)
      const { rows: projects } = await workspace.execute<{ id: string; name: string }>(sql`SELECT id,name FROM workspace_projects
        WHERE "workspaceId"=${workspaceId}::uuid AND id=ANY(${sql.param(page.map(row => row.id))}::uuid[]) AND "archivedAt" IS NULL ORDER BY id`)
      return { workspaceId, serviceIdentityId: id, projects, nextCursor: rows.length > 100 ? page[99].id : null }
    })
  })
}
