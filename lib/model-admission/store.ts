import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { db, withDatabaseClient } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { realCliMembershipGuard, type CliMembershipGuard } from '@/lib/agent-tool-approval/policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { admitModelRoute, GATEWAY_MODEL_ENDPOINT, ModelAdmissionError, modelAdmissionRevision,
  parseModelAdmissionPolicy, subscriptionModelRoute, type GatewayAdmission } from './contract'

export interface ModelAdmissionScope { workspaceId: string; ownerId: string }
export class ModelAdmissionStore {
  constructor(readonly pool: Pick<Pool, 'connect' | 'query'>, readonly membership: CliMembershipGuard = realCliMembershipGuard) {}
  private guard(scope: ModelAdmissionScope, admin = false) {
    z.uuid().parse(scope.workspaceId)
    if (!scope.ownerId) throw new ModelAdmissionError('modelPrincipalUnavailable')
    return async (_tx: PoolClient, signal: AbortSignal) => {
      const lease = await this.membership(scope.workspaceId, scope.ownerId, signal)
      try {
        if (admin) {
          const member = await lease.workspaceClient?.query(`SELECT role FROM mikka_workspace_members
            WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`, [scope.workspaceId, scope.ownerId])
          if (member?.rows[0]?.role !== 'admin') throw new ModelAdmissionError('modelPrincipalUnavailable')
        }
        return lease
      } catch (error) { await lease.close(); throw error }
    }
  }
  private async current(tx: PoolClient, workspaceId: string) {
    const { rows: [row] } = await tx.query(`SELECT model_admission FROM workspace_computer_policies WHERE "workspaceId"=$1 FOR SHARE`, [workspaceId])
    const policy = row?.model_admission == null ? null : parseModelAdmissionPolicy(row.model_admission)
    return { policy, revision: modelAdmissionRevision(policy) }
  }
  read(scope: ModelAdmissionScope) {
    return writeTransaction(this.pool, tx => this.current(tx, scope.workspaceId), { guard: this.guard(scope) })
  }
  set(scope: ModelAdmissionScope, expectedRevision: string, input: unknown) {
    const policy = input === null ? null : parseModelAdmissionPolicy(input)
    let installingPolicy = false
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new ModelAdmissionError('modelPolicyInvalid')
    return writeTransaction(this.pool, async tx => {
      // The same persisted workspace policy used by the central CLI layer.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${scope.workspaceId}`])
      await tx.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission) VALUES ($1,'allow') ON CONFLICT DO NOTHING`, [scope.workspaceId])
      const current = await this.current(tx, scope.workspaceId)
      if (current.revision !== expectedRevision) throw new ModelAdmissionError('modelPolicyChanged')
      installingPolicy = policy !== null && current.policy === null
      await tx.query('UPDATE workspace_computer_policies SET model_admission=$2,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1', [scope.workspaceId, policy])
      await withDatabaseClient(tx, () => recordAudit(db, {
        workspaceId: scope.workspaceId, actor: { type: 'user', id: scope.ownerId, name: scope.ownerId },
        action: 'model.policy_changed', target: { type: 'model-policy', id: scope.workspaceId, label: 'Model admission' },
        metadata: { revision: modelAdmissionRevision(policy), configured: policy !== null },
      }))
      return { policy, revision: modelAdmissionRevision(policy) }
    }, { guard: this.guard(scope, true), guardedWork: async (tx, value, lease) => {
      if (installingPolicy) {
        // Initial installation cannot recall credentials from earlier unmanaged
        // work. Once installed, supported broker calls recheck current rules;
        // live work must not prevent an administrator revoking those rules.
        const links = await lease!.workspaceClient!.query(`SELECT "issueId" FROM mikka_team_issues WHERE "workspaceId"=$1`, [scope.workspaceId])
        const active = await tx.query(`SELECT r.id FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId"
          WHERE r."deviceId" IS NOT NULL AND r.status=ANY($2::text[])
            AND (b."workspaceId"=$1 OR r."issueId"=ANY($3::uuid[])) LIMIT 1`,
        [scope.workspaceId, [...UNFINISHED_RUN_STATUSES], links.rows.map(row => row.issueId)])
        if (active.rowCount) throw new ModelAdmissionError('modelTransportActive')
      }
      return value
    } })
  }
  /** A configured policy requires a current principal; no inferred membership. */
  async gateway(scope: { workspaceId: string; ownerId?: string }, model: string, endpoint = GATEWAY_MODEL_ENDPOINT,
    options: { signal?: AbortSignal; auditAllowed?: boolean } = {}): Promise<(GatewayAdmission & { revision: string }) | null> {
    const admission = await this.admit(scope, model, { provider: 'vercel-gateway', endpoint }, options)
    return admission ? { ...admission, endpoint: GATEWAY_MODEL_ENDPOINT } : null
  }
  subscription(scope: { workspaceId: string; ownerId?: string }, model: string, route: string,
    options: { signal?: AbortSignal; auditAllowed?: boolean } = {}) {
    return this.admit(scope, model, subscriptionModelRoute(route), options)
  }
  private async admit(scope: { workspaceId: string; ownerId?: string }, model: string, transport: { provider: string; endpoint: string },
    options: { signal?: AbortSignal; auditAllowed?: boolean } = {}) {
    const { signal } = options
    if (signal?.aborted) throw new DOMException('Model admission cancelled', 'AbortError')
    const { rows: [row] } = await this.pool.query(`SELECT model_admission FROM workspace_computer_policies WHERE "workspaceId"=$1`, [scope.workspaceId])
    if (row?.model_admission == null) return null
    if (!scope.ownerId) throw new ModelAdmissionError('modelPrincipalUnavailable')
    const identity = { workspaceId: scope.workspaceId, ownerId: scope.ownerId }
    const outcome = await writeTransaction(this.pool, async tx => {
      const current = await this.current(tx, scope.workspaceId)
      // A cleared policy preserves ordinary existing model routing.
      if (!current.policy) return { admission: null }
      try {
        const admission = { ...admitModelRoute(current.policy, { ownerId: identity.ownerId, model, ...transport }), revision: current.revision }
        if (options.auditAllowed !== false) await withDatabaseClient(tx, () => recordAudit(db, {
          workspaceId: scope.workspaceId, actor: { type: 'user', id: identity.ownerId, name: identity.ownerId },
          action: 'model.admitted', metadata: { revision: current.revision, provider: admission.provider, model: admission.model,
            endpoint: admission.endpoint, dataRegion: admission.dataRegion },
        }))
        return { admission }
      } catch (error) {
        if (!(error instanceof ModelAdmissionError)) throw error
        await withDatabaseClient(tx, () => recordAudit(db, {
          workspaceId: scope.workspaceId, actor: { type: 'user', id: identity.ownerId, name: identity.ownerId },
          action: 'model.denied', metadata: { revision: current.revision, reason: error.code },
        }))
        // Commit the refusal audit, then refuse outside the transaction.
        return { error }
      }
    }, { guard: this.guard(identity), signal })
    if ('error' in outcome) throw outcome.error
    return outcome.admission
  }
}
