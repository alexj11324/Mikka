import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { db, withDatabaseClient } from '@/lib/db'
import { recordAudit } from '@/lib/audit/record'
import { realCliMembershipGuard, type CliMembershipGuard } from '@/lib/agent-tool-approval/policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { admitGatewayRoute, GATEWAY_MODEL_ENDPOINT, ModelAdmissionError, modelAdmissionRevision,
  parseModelAdmissionPolicy } from './contract'

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
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new ModelAdmissionError('modelPolicyInvalid')
    return writeTransaction(this.pool, async tx => {
      // The same persisted workspace policy used by the central CLI layer.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-cli-policy:${scope.workspaceId}`])
      await tx.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission) VALUES ($1,'allow') ON CONFLICT DO NOTHING`, [scope.workspaceId])
      const current = await this.current(tx, scope.workspaceId)
      if (current.revision !== expectedRevision) throw new ModelAdmissionError('modelPolicyChanged')
      await tx.query('UPDATE workspace_computer_policies SET model_admission=$2,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1', [scope.workspaceId, policy])
      await withDatabaseClient(tx, () => recordAudit(db, {
        workspaceId: scope.workspaceId, actor: { type: 'user', id: scope.ownerId, name: scope.ownerId },
        action: 'model.policy_changed', target: { type: 'model-policy', id: scope.workspaceId, label: 'Model admission' },
        metadata: { revision: modelAdmissionRevision(policy), configured: policy !== null },
      }))
      return { policy, revision: modelAdmissionRevision(policy) }
    }, { guard: this.guard(scope, true) })
  }
  /** A configured policy requires a current principal; no inferred membership. */
  async gateway(scope: { workspaceId: string; ownerId?: string }, model: string, endpoint = GATEWAY_MODEL_ENDPOINT, signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException('Model admission cancelled', 'AbortError')
    const { rows: [row] } = await this.pool.query(`SELECT model_admission FROM workspace_computer_policies WHERE "workspaceId"=$1`, [scope.workspaceId])
    if (row?.model_admission == null) return null
    if (!scope.ownerId) throw new ModelAdmissionError('modelPrincipalUnavailable')
    const identity = { workspaceId: scope.workspaceId, ownerId: scope.ownerId }
    return writeTransaction(this.pool, async tx => {
      const current = await this.current(tx, scope.workspaceId)
      // A cleared policy preserves ordinary existing model routing.
      return current.policy ? { ...admitGatewayRoute(current.policy, { ownerId: identity.ownerId, model, endpoint }), revision: current.revision } : null
    }, { guard: this.guard(identity), signal })
  }
}
