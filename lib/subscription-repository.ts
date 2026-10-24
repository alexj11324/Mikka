import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { quotaSnapshotSchema, type QuotaSnapshot } from '@mikka/protocol'
import { subscriptionBindingSchema, type SubscriptionRoute, SubscriptionRefusal } from '@mikka/protocol/subscription'
import type { CredentialScope } from '../packages/daemon/src/subscription-worker-client'

export interface ConnectionRow { id: string; ownerId: string; workspaceId: string; provider: 'codex' | 'claude'; state: string; epoch: string; quota: unknown }
export class SubscriptionRepository {
  constructor(readonly pool: Pick<Pool, 'query'>) {}
  async create(ownerId: string, workspaceId: string, provider: 'codex' | 'claude') {
    const id = randomUUID()
    await this.pool.query('insert into byos_connections (id,"ownerId","workspaceId",provider) values ($1,$2,$3,$4)', [id, ownerId, workspaceId, provider])
    return id
  }
  async connection(ownerId: string, id: string): Promise<ConnectionRow> {
    const { rows } = await this.pool.query<ConnectionRow>('select id,"ownerId","workspaceId",provider,state,epoch,quota from byos_connections where id=$1 and "ownerId"=$2', [id, ownerId])
    if (!rows[0]) throw new SubscriptionRefusal('account_unavailable')
    return rows[0]
  }
  scope(row: ConnectionRow): CredentialScope { return { ownerId: row.ownerId, workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider } }
  async bind(ownerId: string, workspaceId: string, consumerId: string, connectionId: string, revision: number, route: SubscriptionRoute, modelId: string) {
    const id = randomUUID()
    const result = await this.pool.query(`insert into byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") select $1,$2,$3,$4,id,epoch,$7,$8 from byos_connections where id=$5 and "ownerId"=$2 and "workspaceId"=$3 and epoch=$6 and state='connected' and provider=$9 returning id`, [id, ownerId, workspaceId, consumerId, connectionId, revision, route, modelId, route.startsWith('codex') ? 'codex' : 'claude'])
    if (!result.rows[0]) throw new SubscriptionRefusal('stale_binding')
    return id
  }
  async binding(ownerId: string, id: string) {
    const { rows } = await this.pool.query('select id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId" from byos_bindings where id=$1 and "ownerId"=$2', [id, ownerId])
    const row = rows[0]
    if (!row) throw new SubscriptionRefusal('binding_required')
    const { modelId, ...binding } = row
    return { ...subscriptionBindingSchema.parse({ ...binding, connectionRevision: Number(row.connectionRevision) }), modelId: String(modelId) }
  }
  async saveQuota(row: ConnectionRow, quota: QuotaSnapshot) {
    await this.pool.query('update byos_connections set quota=$3 where id=$1 and "ownerId"=$2 and epoch=$4 and state=\'connected\'', [row.id, row.ownerId, JSON.stringify(quotaSnapshotSchema.parse(quota)), row.epoch])
  }
  async defaultModelBinding(ownerId: string, consumerId: string): Promise<string | null> {
    const { rows } = await this.pool.query('select id from byos_bindings where "ownerId"=$1 and "consumerId"=$2 and route in (\'codex_cpa\',\'claude_cpa\') order by "createdAt" desc limit 1', [ownerId, consumerId])
    return rows[0]?.id ?? null
  }
}
