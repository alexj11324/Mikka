import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { quotaSnapshotSchema, type QuotaSnapshot } from '@mikka/protocol'
import { subscriptionBindingSchema, type SubscriptionRoute, SubscriptionRefusal } from '@mikka/protocol/subscription'
import type { CredentialScope } from '../packages/daemon/src/subscription-worker-client'
import { runMayUseCredentialSql } from './personal-policy'
import { quotaDisplayKey } from './subscription-quota'

export interface ConnectionRow { id: string; ownerId: string; workspaceId: string; provider: 'codex' | 'claude'; state: string; epoch: string; quota: unknown; accountLabel?: string | null; paused?: boolean; modelCatalog?: { revision: number | string; models: string[] } | null }
export class SubscriptionRepository {
  constructor(readonly pool: Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>) {}
  /** Serialize allocation only: provider calls happen after this short transaction.
   * Reserving a complete bounded operation also lets the expiry sweep recover a
   * request that disappears before its worker starts. */
  async acquire(ownerId: string, workspaceId: string, provider: 'codex' | 'claude') {
    if (!this.pool.connect) throw new SubscriptionRefusal('backend_unavailable')
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query("set local lock_timeout='5s'")
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['subscription_acquire', ownerId, workspaceId, provider])])
      const { rows } = await client.query<{ id: string }>(`select c.id from byos_connections c where c."ownerId"=$1 and c."workspaceId"=$2 and c.provider=$3 and c."removedAt" is null and c.state='pending' and c."operationKind"='acquire' and c."operationDeadline">now()
        and not exists (select 1 from byos_enrollment_transfers t where t."connectionId"=c.id and t.epoch=c.epoch and t."operationId"=c."operationId")
        order by c."createdAt" desc limit 1`, [ownerId, workspaceId, provider])
      const connectionId = rows[0]?.id ?? randomUUID()
      if (!rows[0]) await client.query(`insert into byos_connections (id,"ownerId","workspaceId",provider,state,"operationId","operationKind","operationDeadline") values ($1,$2,$3,$4,'pending',$5,'acquire',now()+interval '5 minutes')`, [connectionId, ownerId, workspaceId, provider, randomUUID()])
      await client.query('commit')
      return { connectionId, created: !rows[0] }
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  async create(ownerId: string, workspaceId: string, provider: 'codex' | 'claude') {
    const id = randomUUID()
    await this.pool.query('insert into byos_connections (id,"ownerId","workspaceId",provider) values ($1,$2,$3,$4)', [id, ownerId, workspaceId, provider])
    return id
  }
  async connection(ownerId: string, id: string): Promise<ConnectionRow> {
    const { rows } = await this.pool.query<ConnectionRow>('select id,"ownerId","workspaceId",provider,state,epoch,quota,"accountLabel",paused,"modelCatalog" from byos_connections where id=$1 and "ownerId"=$2', [id, ownerId])
    if (!rows[0]) throw new SubscriptionRefusal('account_unavailable')
    return rows[0]
  }
  scope(row: ConnectionRow): CredentialScope { return { ownerId: row.ownerId, workspaceId: row.workspaceId, connectionId: row.id, provider: row.provider } }
  async bind(ownerId: string, workspaceId: string, consumerId: string, connectionId: string, revision: number, route: SubscriptionRoute, modelId: string) {
    const id = randomUUID()
    const result = await this.pool.query(`insert into byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") select $1,$2,$3,$4,id,epoch,$7,$8 from byos_connections where id=$5 and "ownerId"=$2 and "workspaceId"=$3 and epoch=$6 and state='connected' and paused=false and provider=$9 returning id`, [id, ownerId, workspaceId, consumerId, connectionId, revision, route, modelId, route.startsWith('codex') ? 'codex' : 'claude'])
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
  /** One fresh database snapshot for a frozen model's binding and connection.
   * Keep a missing connection distinct from a missing/mismatched binding. */
  async bindingConnection(ownerId: string, id: string) {
    const { rows } = await this.pool.query<{ connection: ConnectionRow | null; connectionRevision: string; modelId: string }>(`
      select b.id,b."ownerId",b."workspaceId",b."consumerId",b."connectionId",b."connectionRevision",b.route,b."modelId",
        case when c.id is null then null else json_build_object(
          'id',c.id,'ownerId',c."ownerId",'workspaceId',c."workspaceId",'provider',c.provider,
          'state',c.state,'epoch',c.epoch::text,'quota',c.quota,'accountLabel',c."accountLabel",'paused',c.paused
        ) end as connection
      from byos_bindings b left join byos_connections c on c.id=b."connectionId" and c."ownerId"=b."ownerId"
      where b.id=$1 and b."ownerId"=$2`, [id, ownerId])
    const row = rows[0]
    if (!row) throw new SubscriptionRefusal('binding_required')
    const { modelId, connection, ...binding } = row
    return {
      binding: { ...subscriptionBindingSchema.parse({ ...binding, connectionRevision: Number(row.connectionRevision) }), modelId: String(modelId) },
      connection,
    }
  }
  async saveQuota(row: ConnectionRow, quota: QuotaSnapshot, options: { preservePlan?: true } = {}) {
    // SET preserves the current locked plan; RETURNING retains the original statement snapshot.
    const sql = options.preservePlan
      ? `update byos_connections set quota=$3||jsonb_build_object('plan',quota->'plan') where id=$1 and "ownerId"=$2 and epoch=$4 and state='connected' returning(select quota from byos_connections where id=$1 and "ownerId"=$2)as previous`
      : `with old as (select quota from byos_connections where id=$1 and "ownerId"=$2)
      update byos_connections set quota=$3 where id=$1 and "ownerId"=$2 and epoch=$4 and state='connected' returning (select quota from old) as previous`
    const { rows: [saved] } = await this.pool.query<{ previous: unknown }>(sql, [row.id, row.ownerId, JSON.stringify(quotaSnapshotSchema.parse(quota)), row.epoch])
    // 待检查 / 额度用完 in 优先使用的模型 follow a new read wherever it came from (检查额度, the meters, dispatch),
    // pushed only when what the page shows changes.
    if (saved && quotaDisplayKey(saved.previous) !== quotaDisplayKey(quota)) await (await import('./live/lists')).ownerSettingsChanged(this.pool, row.ownerId)
  }
  /** The owner's own sign-in email, for Settings; fenced to the read's epoch. */
  async saveAccountLabel(row: ConnectionRow, label: string) {
    await this.pool.query('update byos_connections set "accountLabel"=$3 where id=$1 and "ownerId"=$2 and epoch=$4', [row.id, row.ownerId, label, row.epoch])
  }
  /** 暂停: Bots stop using this connection; it stays connected and its quota stays readable. */
  async setPaused(ownerId: string, id: string, paused: boolean) {
    const { rowCount } = await this.pool.query('update byos_connections set paused=$3 where id=$1 and "ownerId"=$2 and state<>\'disconnected\'', [id, ownerId, paused])
    if (!rowCount) throw new SubscriptionRefusal('account_unavailable')
  }
  /** 移除: hide a disconnected connection from the owner's list. */
  async remove(ownerId: string, id: string) {
    const { rowCount } = await this.pool.query('update byos_connections set "removedAt"=now() where id=$1 and "ownerId"=$2 and state=\'disconnected\'', [id, ownerId])
    if (!rowCount) throw new SubscriptionRefusal('account_unavailable')
  }
  /** Saved chat selections for the owner's active bots in the authorized workspace.
   * A binding is history, not proof of a current choice or an active run. Neither
   * another workspace nor another member's bot is part of this personal view.
   * Connections remain account-level: their original workspace does not limit use.
   * A paused/reconnected account can still be selected; its row states availability.
   */
  async connectionBots(ownerId: string, workspaceId: string) {
    const { rows } = await this.pool.query<{ connectionId: string; id: string; name: string; color: string; shape: string; workspaceId: string }>(`
      select c.id as "connectionId",bot.id,bot.name,bot.color,bot.shape,bot."workspaceId"::text as "workspaceId"
      from bot_model_choices choice
      left join coordinator_bots cb on choice."botKey"='coordinator' and cb."ownerId"=choice."ownerId" and cb."workspaceId"=choice."workspaceId"
      join bots bot on bot.id::text=case when choice."botKey"='coordinator' then cb."botId"::text else choice."botKey" end
        and bot."ownerId"=choice."ownerId" and bot."workspaceId"=choice."workspaceId" and bot."archivedAt" is null
      join byos_bindings b on b.id=choice."bindingId" and b."ownerId"=choice."ownerId"
      join byos_connections c on c.id=b."connectionId" and c."ownerId"=choice."ownerId" and c."removedAt" is null
      where choice."ownerId"=$1 and choice."workspaceId"=$2 and choice."apiKeyId" is null
        and (choice."botKey"<>'coordinator' or not exists (
          select 1 from bot_model_choices current where current."ownerId"=choice."ownerId"
            and current."workspaceId"=choice."workspaceId" and current."botKey"=bot.id::text))
      order by bot.name,bot.id limit 200`, [ownerId, workspaceId])
    return rows
  }
  async defaultModelBinding(ownerId: string, consumerId: string): Promise<string | null> {
    const { rows } = await this.pool.query('select id from byos_bindings where "ownerId"=$1 and "consumerId"=$2 and route in (\'codex_cpa\',\'claude_cpa\') order by "createdAt" desc limit 1', [ownerId, consumerId])
    return rows[0]?.id ?? null
  }
  async nativeBinding(ownerId: string, consumerId: string, harness: string, bindingId?: string, workspaceId?: string, options: { currentConnection?: true } = {}) {
    if (harness !== 'codex' && harness !== 'claude_code') return null
    const route = harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
    // The task's Agent belongs to the caller. A binding may still belong to a different person
    // who shared a subscription in this workspace; retain that owner for quota, leases and revocation.
    const { rows: [row] } = await this.pool.query<{ id: string; ownerId: string; workspaceId: string }>(
      `SELECT b.id,b."ownerId",b."workspaceId" FROM byos_bindings b JOIN agents a ON a.id::text=b."consumerId" AND a."userId"=$1
        WHERE b."consumerId"=$2 AND b.route=$3 AND ($4::uuid IS NULL OR b.id=$4) AND ($5::text IS NULL OR b."workspaceId"=$5)
          AND ${runMayUseCredentialSql('b."ownerId"', '$1', 'b."workspaceId"')}
        ORDER BY b."createdAt" DESC,b.id DESC LIMIT 1`, [ownerId, consumerId, route, bindingId ?? null, workspaceId ?? null])
    if (!row) return null
    if (row.ownerId !== ownerId) {
      try {
        const { authorizeSubscriptionWorkspace } = await import('./subscription-runtime')
        await authorizeSubscriptionWorkspace(ownerId, row.workspaceId)
        await authorizeSubscriptionWorkspace(row.ownerId, row.workspaceId, ownerId)
      } catch { return null }
    }
    if (!options.currentConnection) return this.binding(row.ownerId, row.id)
    // Membership may have awaited a different database. Re-read this exact
    // binding, its original scope and its current connection together after it;
    // never fall through to an older binding if the selected one was revoked.
    const { rows: [current] } = await this.pool.query(`SELECT b.id,b."ownerId",b."workspaceId",b."consumerId",b."connectionId",b."connectionRevision",b.route,b."modelId"
      FROM byos_bindings b JOIN agents a ON a.id::text=b."consumerId" AND a."userId"=$1
      JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
        AND c.state='connected' AND c.paused=false AND c.epoch=b."connectionRevision" AND c.provider=$7
      WHERE b."consumerId"=$2 AND b.route=$3 AND b.id=$4 AND b."workspaceId"=$5 AND b."ownerId"=$6
        AND ${runMayUseCredentialSql('b."ownerId"', '$1', 'b."workspaceId"')}`,
    [ownerId, consumerId, route, row.id, row.workspaceId, row.ownerId, harness === 'codex' ? 'codex' : 'claude'])
    if (!current) return null
    const { modelId, ...binding } = current
    return { ...subscriptionBindingSchema.parse({ ...binding, connectionRevision: Number(current.connectionRevision) }), modelId: String(modelId) }
  }
}
