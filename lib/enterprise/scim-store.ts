import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { applyScimPatch, parseScim, ScimError, scimGroupInput, scimUserInput, type ScimGroupDocument, type ScimUserDocument } from './scim-protocol'
import { armDueTimerSoon } from '../due-timer'
import { lockOrganizationLiveAuthority, revokeOrganizationLiveCapabilities } from './live-store'

export type ScimConnection = { id: string; organizationId: string; providerId: string }
export type DirectoryUser = QueryResultRow & {
  id: string; connectionId: string; organizationId: string; externalId: string; userName: string; userId: string | null;
  active: boolean; deleted: boolean; revision: number; document: ScimUserDocument; createdAt: Date; updatedAt: Date;
}
export type DirectoryGroup = QueryResultRow & { id: string; connectionId: string; document: ScimGroupDocument; revision: number; createdAt: Date; updatedAt: Date }
export type DirectoryChange = { connection: ScimConnection; user: DirectoryUser; action: 'created' | 'updated' | 'suspended' | 'deleted'; eventId?: string }
export const identityTokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
type Executor = Pick<PoolClient, 'query'>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export class ScimStore {
  constructor(readonly pool: Pool, readonly afterUserChange: (change: DirectoryChange) => Promise<void>,
    readonly afterGroupChange: (connection: ScimConnection, groupId: string, eventId?: string) => Promise<void> = async () => {}) {}

  async authenticate(id: string, authorization: string | null): Promise<ScimConnection> {
    const match = /^Bearer (msc_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')
    if (!uuid.test(id) || !match) throw new ScimError(401, '', 'Invalid provisioning credential')
    const { rows } = await this.pool.query<ScimConnection>(`select c.id,c."organizationId",c."providerId" from enterprise_scim_connection c
      join enterprise_sso_provider p on p."providerId"=c."providerId" and p."organizationScopeId"=c."organizationId"
      where c.id=$1 and c."tokenHash"=$2 and c."revokedAt" is null and p."domainVerified"`, [id, identityTokenHash(match[1])])
    if (!rows[0]) throw new ScimError(401, '', 'Invalid provisioning credential')
    return rows[0]
  }

  private async enqueueChange(tx: Executor, connection: ScimConnection, kind: 'Users' | 'Groups', resourceId: string, action: DirectoryChange['action'] | 'group_changed') {
    await tx.query(`insert into enterprise_scim_outbox (id,"connectionId","organizationId",kind,"resourceId",action)
      values ($1,$2,$3,$4,$5,$6)`, [randomUUID(), connection.id, connection.organizationId, kind, resourceId, action])
  }

  /** The directory mutation commits before delivery. Keep the per-directory
   * serializer in WS, release every APP checkout before callbacks, and ACK
   * only after the WS commit. A lost ACK safely reuses the stable audit ID. */
  async drain(connection: ScimConnection, force = true) {
    const [{ drainOrganizationLiveRevocations }, { workspaceDb }, { sql }] = await Promise.all([
      import('./live-authority'), import('../workspace-db'), import('drizzle-orm'),
    ])
    await drainOrganizationLiveRevocations(connection.organizationId)
    const delivered = await workspaceDb.transaction(async workspace => {
      const lock = await workspace.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`enterprise-scim:${connection.id}`},0)) as acquired`)
      if (lock.rows[0]?.acquired !== true) return []
      const { rows } = await this.pool.query<{ id: string; kind: 'Users' | 'Groups'; resourceId: string; action: DirectoryChange['action'] }>(`select id,kind,"resourceId",action from enterprise_scim_outbox
        where "connectionId"=$1 and "deliveredAt" is null and ($2 or "lastAttemptAt" is null or "lastAttemptAt"<=now()-interval '30 seconds')
        order by "createdAt",id limit 100`, [connection.id, force])
      const completed: string[] = []
      for (const event of rows) {
        const claim = await this.pool.query('update enterprise_scim_outbox set "lastAttemptAt"=now() where id=$1 and "deliveredAt" is null', [event.id])
        if (!claim.rowCount) continue
        if (event.kind === 'Groups') await this.afterGroupChange(connection, event.resourceId, event.id)
        else {
          const { rows: [user] } = await this.pool.query<DirectoryUser>('select * from enterprise_scim_user where id=$1 and "connectionId"=$2', [event.resourceId, connection.id])
          if (!user) throw new Error('enterprise_directory_event_missing')
          // Never replay request bodies. The serialized delivery observes the
          // newest committed directory state, including a later disable.
          await this.afterUserChange({ connection, user, action: event.action, eventId: event.id })
        }
        completed.push(event.id)
      }
      return completed
    })
    if (delivered.length) await this.pool.query('update enterprise_scim_outbox set "deliveredAt"=now() where id=any($1::uuid[]) and "deliveredAt" is null', [delivered])
  }

  private async transaction<T>(connection: ScimConnection, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect()
    try {
      await tx.query('begin')
      const { rows } = await tx.query('select id from enterprise_scim_connection where id=$1 and "revokedAt" is null for update', [connection.id])
      if (!rows.length) throw new ScimError(401, '', 'Provisioning connection was revoked')
      const result = await work(tx)
      await tx.query('commit')
      armDueTimerSoon('audit-retention')
      return result
    } catch (error) {
      await tx.query('rollback')
      if ((error as { code?: string })?.code === '23505') throw new ScimError(409, 'uniqueness', 'The identity already exists', { cause: error })
      throw error
    } finally { tx.release() }
  }

  async list(connection: ScimConnection, kind: 'Users' | 'Groups', query: { count: number; startIndex: number; filter?: { field: 'userName' | 'externalId' | 'displayName'; value: string } }) {
    const table = kind === 'Users' ? 'enterprise_scim_user' : 'enterprise_scim_group'
    const filter = query.filter
    const predicate = `"connectionId"=$1${kind === 'Users' ? ' and not deleted' : ''}${filter ? ` and "${filter.field}"=$2` : ''}`
    const values = filter ? [connection.id, filter.value] : [connection.id]
    const { rows: totals } = await this.pool.query<{ count: string }>(`select count(*) from ${table} where ${predicate}`, values)
    const { rows } = await this.pool.query<DirectoryUser | DirectoryGroup>(`select * from ${table} where ${predicate} order by "createdAt",id limit $${values.length + 1} offset $${values.length + 2}`, [...values, query.count, query.startIndex - 1])
    return { rows, totalResults: Number(totals[0].count) }
  }

  async get(connection: ScimConnection, kind: 'Users', id: string): Promise<DirectoryUser>
  async get(connection: ScimConnection, kind: 'Groups', id: string): Promise<DirectoryGroup>
  async get(connection: ScimConnection, kind: 'Users' | 'Groups', id: string): Promise<DirectoryUser | DirectoryGroup>
  async get(connection: ScimConnection, kind: 'Users' | 'Groups', id: string) {
    if (!uuid.test(id)) throw new ScimError(404, '', 'Resource not found')
    const table = kind === 'Users' ? 'enterprise_scim_user' : 'enterprise_scim_group'
    const { rows } = await this.pool.query<DirectoryUser | DirectoryGroup>(`select * from ${table} where id=$1 and "connectionId"=$2${kind === 'Users' ? ' and not deleted' : ''}`, [id, connection.id])
    if (!rows[0]) throw new ScimError(404, '', 'Resource not found')
    return rows[0]
  }

  async createUser(connection: ScimConnection, input: unknown) {
    const document = parseScim(scimUserInput, input)
    const result = await this.transaction(connection, async tx => {
      // A per-connection lock makes repeated externalId creates deterministic without locking other tenants.
      await tx.query('select id from enterprise_scim_connection where id=$1 for update', [connection.id])
      const { rows: existing } = await tx.query<DirectoryUser>('select * from enterprise_scim_user where "connectionId"=$1 and "externalId"=$2 for update', [connection.id, document.externalId])
      if (existing[0]) {
        if (existing[0].userName !== document.userName) throw new ScimError(409, 'uniqueness', 'externalId is already bound')
        const user = await this.saveUser(tx, connection, existing[0], document)
        return { user, created: false }
      }
      const { rows: matches } = await tx.query<{ id: string }>('select id from "user" where lower(email)=$1', [document.userName])
      // Existing personal accounts require a fresh signed-in, protocol-proven linking ceremony.
      // Never turn matching email text into permission to authenticate as that account.
      let userId: string | null = null
      if (!matches.length) {
        userId = randomUUID()
        await tx.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,false,now(),now())',
          [userId, document.displayName || document.name?.formatted || document.userName, document.userName])
      }
      const { rows } = await tx.query<DirectoryUser>(`insert into enterprise_scim_user (id,"connectionId","organizationId","externalId","userName","userId",active,document)
        values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [randomUUID(), connection.id, connection.organizationId, document.externalId, document.userName, userId, document.active, document])
      if (!document.active) await this.queueRevocation(tx, rows[0])
      await this.enqueueChange(tx, connection, 'Users', rows[0].id, document.active ? 'created' : 'suspended')
      return { user: rows[0], created: true }
    })
    await this.drain(connection)
    return result
  }

  async updateUser(connection: ScimConnection, id: string, input: unknown, patch: boolean, ifMatch: string | null) {
    if (!uuid.test(id)) throw new ScimError(404, '', 'Resource not found')
    const user = await this.transaction(connection, async tx => {
      const { rows } = await tx.query<DirectoryUser>('select * from enterprise_scim_user where id=$1 and "connectionId"=$2 and not deleted for update', [id, connection.id])
      const current = rows[0]
      if (!current) throw new ScimError(404, '', 'Resource not found')
      this.matchRevision(current, ifMatch)
      const document = patch ? applyScimPatch('Users', current.document, input) : parseScim(scimUserInput, input)
      return this.saveUser(tx, connection, current, document)
    })
    await this.drain(connection)
    return user
  }

  private matchRevision(row: { revision: number }, match: string | null) {
    if (match && match !== `W/"${row.revision}"`) throw new ScimError(412, '', 'The resource changed')
  }

  private async saveUser(tx: Executor, connection: ScimConnection, current: DirectoryUser, document: ScimUserDocument) {
    if (current.externalId !== document.externalId) throw new ScimError(400, 'mutability', 'externalId is immutable')
    const changed = current.deleted || !isDeepStrictEqual(current.document, document)
    if (!changed) return current
    const { rows } = await tx.query<DirectoryUser>(`update enterprise_scim_user set "userName"=$3,active=$4,deleted=false,document=$5,revision=revision+1,"updatedAt"=now()
      where id=$1 and "connectionId"=$2 returning *`, [current.id, connection.id, document.userName, document.active, document])
    if (!document.active) await this.queueRevocation(tx, rows[0])
    await this.enqueueChange(tx, connection, 'Users', rows[0].id, document.active ? 'updated' : 'suspended')
    return rows[0]
  }

  private async queueRevocation(tx: Executor, user: DirectoryUser, deferLive = false) {
    if (!user.userId) return
    await lockOrganizationLiveAuthority(tx, user.organizationId)
    await tx.query('insert into enterprise_revocation (id,"organizationId","directoryUserId","userId") values ($1,$2,$3,$4)', [randomUUID(), user.organizationId, user.id, user.userId])
    // Removing only the organization proof leaves personal and unrelated organization sessions intact.
    await tx.query('update session set "enterpriseOrganizationId"=null,"enterpriseProviderId"=null,"enterpriseDirectoryUserId"=null,"enterpriseIdentityId"=null where "enterpriseDirectoryUserId"=$1', [user.id])
    if (!deferLive) await revokeOrganizationLiveCapabilities(tx, user.organizationId, user.userId)
  }

  async deleteUser(connection: ScimConnection, id: string, ifMatch: string | null) {
    if (!uuid.test(id)) throw new ScimError(404, '', 'Resource not found')
    await this.transaction(connection, async tx => {
      const { rows } = await tx.query<DirectoryUser>('select * from enterprise_scim_user where id=$1 and "connectionId"=$2 for update', [id, connection.id])
      if (!rows[0]) throw new ScimError(404, '', 'Resource not found')
      this.matchRevision(rows[0], ifMatch)
      if (rows[0].deleted) return rows[0]
      const { rows: updated } = await tx.query<DirectoryUser>('update enterprise_scim_user set deleted=true,active=false,revision=revision+1,"updatedAt"=now() where id=$1 returning *', [id])
      await this.queueRevocation(tx, updated[0])
      await this.enqueueChange(tx, connection, 'Users', id, 'deleted')
      return updated[0]
    })
    await this.drain(connection)
  }

  private async checkGroupMembers(tx: Executor, connection: ScimConnection, document: ScimGroupDocument) {
    const ids = [...new Set(document.members.map(member => member.value))]
    if (!ids.length) return
    const { rows } = await tx.query('select id from enterprise_scim_user where "connectionId"=$1 and id=any($2::uuid[]) and not deleted', [connection.id, ids])
    if (rows.length !== ids.length) throw new ScimError(400, 'invalidValue', 'A group member does not belong to this directory')
  }

  async createGroup(connection: ScimConnection, input: unknown) {
    const document = parseScim(scimGroupInput, input)
    const result = await this.transaction(connection, async tx => {
      await tx.query('select id from enterprise_scim_connection where id=$1 for update', [connection.id])
      await this.checkGroupMembers(tx, connection, document)
      if (document.externalId) {
        const { rows } = await tx.query<DirectoryGroup>('select * from enterprise_scim_group where "connectionId"=$1 and "externalId"=$2 for update', [connection.id, document.externalId])
        if (rows[0]) return { group: await this.saveGroup(tx, connection, rows[0], document), created: false }
      }
      const { rows } = await tx.query<DirectoryGroup>('insert into enterprise_scim_group (id,"connectionId","externalId","displayName",document) values ($1,$2,$3,$4,$5) returning *', [randomUUID(), connection.id, document.externalId ?? null, document.displayName, document])
      await this.enqueueChange(tx, connection, 'Groups', rows[0].id, 'group_changed')
      return { group: rows[0], created: true }
    })
    await this.drain(connection)
    return result
  }

  private async saveGroup(tx: Executor, connection: ScimConnection, current: DirectoryGroup, document: ScimGroupDocument) {
    if (current.document.externalId && current.document.externalId !== document.externalId) throw new ScimError(400, 'mutability', 'externalId is immutable')
    await this.checkGroupMembers(tx, connection, document)
    if (isDeepStrictEqual(current.document, document)) return current
    const { rows } = await tx.query<DirectoryGroup>('update enterprise_scim_group set "externalId"=$3,"displayName"=$4,document=$5,revision=revision+1,"updatedAt"=now() where id=$1 and "connectionId"=$2 returning *', [current.id, connection.id, document.externalId ?? null, document.displayName, document])
    await this.enqueueChange(tx, connection, 'Groups', current.id, 'group_changed')
    return rows[0]
  }

  async updateGroup(connection: ScimConnection, id: string, input: unknown, patch: boolean, ifMatch: string | null) {
    if (!uuid.test(id)) throw new ScimError(404, '', 'Resource not found')
    const group = await this.transaction(connection, async tx => {
      const { rows } = await tx.query<DirectoryGroup>('select * from enterprise_scim_group where id=$1 and "connectionId"=$2 for update', [id, connection.id])
      if (!rows[0]) throw new ScimError(404, '', 'Resource not found')
      this.matchRevision(rows[0], ifMatch)
      return this.saveGroup(tx, connection, rows[0], patch ? applyScimPatch('Groups', rows[0].document, input) : parseScim(scimGroupInput, input))
    })
    await this.drain(connection)
    return group
  }

  async deleteGroup(connection: ScimConnection, id: string, ifMatch: string | null) {
    if (!uuid.test(id)) throw new ScimError(404, '', 'Resource not found')
    await this.transaction(connection, async tx => {
      const { rows } = await tx.query<DirectoryGroup>('select * from enterprise_scim_group where id=$1 and "connectionId"=$2 for update', [id, connection.id])
      if (!rows[0]) return
      this.matchRevision(rows[0], ifMatch)
      await tx.query('delete from enterprise_scim_group where id=$1 and "connectionId"=$2', [id, connection.id])
      await this.enqueueChange(tx, connection, 'Groups', id, 'group_changed')
    })
    await this.drain(connection)
  }

  /** Administrative revocation fences sign-in and provisioning before asynchronous workspace cleanup. */
  async revokeConnection(organizationId: string, connectionId: string, beforeCommit?: (tx: PoolClient, connection: ScimConnection) => Promise<void>, options: { deferDelivery?: boolean } = {}) {
    const tx = await this.pool.connect()
    let connection: ScimConnection
    try {
      await tx.query('begin')
      await tx.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
      const { rows: [found] } = await tx.query<ScimConnection>('select id,"organizationId","providerId" from enterprise_scim_connection where id=$1 and "organizationId"=$2 for update', [connectionId, organizationId])
      if (!found) throw new ScimError(404, '', 'Provisioning connection not found')
      connection = found
      await tx.query('update enterprise_scim_connection set "revokedAt"=coalesce("revokedAt",now()),fence=fence+1 where id=$1', [connection.id])
      const { rows: users } = await tx.query<DirectoryUser>(`update enterprise_scim_user set active=false,document=jsonb_set(document,'{active}','false'::jsonb),
        revision=revision+case when active then 1 else 0 end,"updatedAt"=now() where "connectionId"=$1 returning *`, [connection.id])
      // Finish every session mutation before taking remaining cap row locks.
      // A native session DELETE must never wait on a cap we hold while this
      // transaction is waiting for that same session row.
      for (const user of users) {
        await this.queueRevocation(tx, user, true)
        await this.enqueueChange(tx, connection, 'Users', user.id, user.deleted ? 'deleted' : 'suspended')
      }
      for (const user of users) if (user.userId) await revokeOrganizationLiveCapabilities(tx, organizationId, user.userId)
      if (beforeCommit) await beforeCommit(tx, connection)
      await tx.query('commit')
      armDueTimerSoon('audit-retention')
    } catch (error) { await tx.query('rollback'); throw error } finally { tx.release() }
    if (!options.deferDelivery) await this.drain(connection)
    return connection
  }
}
