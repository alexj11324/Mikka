import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { approvalModeSchema, networkAllowSchema, storedPermissionsSchema } from '@mikka/protocol/agent-policy'
import { governanceApprovalTemplates } from '@/lib/db/team-entitlements-schema'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { pool } from '@/lib/db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { stopRunsForPolicyChange } from '@/lib/run-policy-stop'
import { recordAudit } from '@/lib/audit/record'
import { workspaceListChanged } from '@/lib/live/lists'
import { requireGovernanceFeature } from './entitlements'
import { readGovernanceLease } from './lease'
import { GovernanceError } from './errors'
import { enterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'

/** Exactly the existing CLI policy fields. Templates do not alter computer/external-write authority. */
export const approvalTemplateRulesSchema = z.object({
  permissions: storedPermissionsSchema.omit({ computer_use: true }).optional(),
  networkAllow: networkAllowSchema.optional(), approvalMode: approvalModeSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0)
const templateInputSchema = z.object({ id: z.uuid().optional(), name: z.string().trim().min(1).max(120), rules: approvalTemplateRulesSchema }).strict()
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function listApprovalTemplates(workspaceId: string, reader: string | EnterpriseReader) {
  const userId = typeof reader === 'string' ? reader : reader.id
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, userId, true, typeof reader === 'string' ? undefined : reader[enterprisePrincipal])
    await requireGovernanceFeature(tx, workspaceId, 'approvalTemplates')
    return tx.select().from(governanceApprovalTemplates).where(eq(governanceApprovalTemplates.workspaceId, workspaceId)).orderBy(asc(governanceApprovalTemplates.createdAt))
  })
}

export async function saveApprovalTemplate(workspaceId: string, reader: string | EnterpriseReader, input: unknown) {
  const userId = typeof reader === 'string' ? reader : reader.id
  const value = templateInputSchema.parse(input)
  return workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, userId, true, typeof reader === 'string' ? undefined : reader[enterprisePrincipal])
    const scope = await requireGovernanceFeature(tx, workspaceId, 'approvalTemplates')
    const id = value.id ?? randomUUID()
    if (value.id) {
      const rows = await tx.update(governanceApprovalTemplates).set({ name: value.name, rules: value.rules, updatedAt: new Date() }).where(and(eq(governanceApprovalTemplates.id, id), eq(governanceApprovalTemplates.workspaceId, workspaceId))).returning()
      if (!rows.length) throw new GovernanceError('not_found')
    } else {
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(governanceApprovalTemplates).where(eq(governanceApprovalTemplates.workspaceId, workspaceId))
      if (count >= scope.entitlements.approvalTemplateLimit) throw new GovernanceError('template_limit')
      await tx.insert(governanceApprovalTemplates).values({ id, workspaceId, name: value.name, rules: value.rules, createdBy: userId })
    }
    await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: userId, name: membership.name }, action: 'agent.policy_changed', target: { type: 'approval_template', id }, metadata: { scope: 'workspace', revision: revision(value.rules) } })
    await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
    return { id }
  })
}

export async function deleteApprovalTemplate(workspaceId: string, reader: string | EnterpriseReader, templateId: string) {
  const userId = typeof reader === 'string' ? reader : reader.id
  await workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, userId, true, typeof reader === 'string' ? undefined : reader[enterprisePrincipal])
    await requireGovernanceFeature(tx, workspaceId, 'approvalTemplates')
    const rows = await tx.delete(governanceApprovalTemplates).where(and(eq(governanceApprovalTemplates.id, z.uuid().parse(templateId)), eq(governanceApprovalTemplates.workspaceId, workspaceId))).returning()
    if (!rows.length) throw new GovernanceError('not_found')
    await enqueueWorkspaceAudit(tx, { workspaceId, actor: { type: 'user', id: userId, name: membership.name }, action: 'agent.policy_changed', target: { type: 'approval_template', id: templateId }, metadata: { scope: 'workspace', revision: revision(['deleted', templateId]) } })
    await workspaceListChanged(tx, workspaceId, ['workspace_settings'])
  })
}

/** Applies a persisted, tenant-scoped template to the policy read by real run admission. */
export async function applyApprovalTemplate(workspaceId: string, reader: string | EnterpriseReader, templateId: string) {
  const userId = typeof reader === 'string' ? reader : reader.id
  z.uuid().parse(workspaceId); z.uuid().parse(templateId)
  return withTaskWorkspace(reader, workspaceId, () => writeTransaction(pool, async tx => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${workspaceId}`])
    const scope = await readGovernanceLease(workspacePool, workspaceId, userId)
    if (scope.role !== 'admin') throw new GovernanceError('access_denied')
    if (!scope.entitlements.approvalTemplates) throw new GovernanceError('feature_unavailable')
    const { rows: [template] } = await workspacePool.query<{ rules: unknown }>('select rules from mikka_governance_approval_templates where id=$1 and "workspaceId"=$2 for share', [templateId, workspaceId])
    if (!template) throw new GovernanceError('not_found')
    const rules = approvalTemplateRulesSchema.parse(template.rules)
    await tx.query('insert into workspace_computer_policies ("workspaceId",permission) values ($1,\'allow\') on conflict ("workspaceId") do nothing', [workspaceId])
    await tx.query('update workspace_computer_policies set cli_run_policy=$2 where "workspaceId"=$1', [workspaceId, rules])
    await recordAudit(drizzle(tx), { workspaceId, actor: { type: 'user', id: userId, name: userId }, action: 'agent.policy_changed', target: { type: 'approval_template', id: templateId }, metadata: { scope: 'workspace', revision: revision(rules) } })
    await stopRunsForPolicyChange(tx, { kind: 'workspace', workspaceId })
    return { applied: true as const }
  }))
}
