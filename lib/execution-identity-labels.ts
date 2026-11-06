import 'server-only'
import type { Pool } from 'pg'
import type { ExecutionIdentity } from '@/lib/execution-identity'
import { deviceMachineKind } from '@/lib/thread-machine'
import type { ExecutionIdentityLabels } from '@/lib/execution-identity-label-view'

const uniq = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))]
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/**
 * Names for the references a run's frozen execution identity holds, so the
 * owner's 「执行身份与费用归属」 dialog shows people, machines and accounts
 * instead of IDs (Alex, 2026-11-06). Reads only the rows those references name.
 * Masked hints (an email, a key's last four) are shown only for the viewer's own
 * accounts; someone else's shared account is named by its provider alone. A row
 * deleted since the run leaves its reference unlabelled.
 */
export async function executionIdentityLabels(pool: Pool, workspacePool: Pool, viewerId: string, identity: ExecutionIdentity): Promise<ExecutionIdentityLabels> {
  const bindings = identity.resourceBindings
  const accounts = [identity.billingAccount.model, identity.billingAccount.runtime]
  const ids = (kind: string) => uniq([...bindings.filter(item => item.kind === kind).map(item => item.id), ...accounts.filter(item => item.kind === kind).map(item => item.resourceId)])
  const deviceIds = uniq([...ids('device'), ...ids('local_device'), ...ids('native_login')]).filter(isUuid)
  const subscriptionIds = ids('subscription').filter(isUuid)
  const keyIds = ids('api_key').filter(isUuid)
  const mcpIds = ids('mcp').filter(isUuid)
  const people = uniq([identity.requester, identity.botOwner, identity.executionPrincipal, identity.outputOwner,
    ...bindings.map(item => item.ownerId), ...accounts.map(item => item.ownerId)])
  const usesE2b = bindings.some(item => item.kind === 'e2b' && item.ownerId === viewerId) || accounts.some(item => item.kind === 'e2b' && item.ownerId === viewerId)
  const [workspace, users, devices, subscriptions, keys, mcp, e2b] = await Promise.all([
    identity.workspaceId && isUuid(identity.workspaceId)
      ? workspacePool.query<{ name: string }>('SELECT name FROM mikka_workspaces WHERE id=$1', [identity.workspaceId]).then(result => result.rows[0] ?? null) : null,
    people.length ? pool.query<{ id: string; name: string | null; email: string | null; image: string | null }>('SELECT id,name,email,image FROM "user" WHERE id=ANY($1::text[])', [people]).then(result => result.rows) : [],
    deviceIds.length ? pool.query<{ id: string; name: string; kind: string | null; deviceType: string | null; platform: string | null }>('SELECT id,name,kind,"deviceType",platform FROM devices WHERE id=ANY($1::uuid[])', [deviceIds]).then(result => result.rows) : [],
    subscriptionIds.length ? pool.query<{ id: string; provider: string; accountLabel: string | null; ownerId: string }>(`SELECT b.id, c.provider, c."accountLabel", c."ownerId"
      FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" WHERE b.id=ANY($1::uuid[])`, [subscriptionIds]).then(result => result.rows) : [],
    keyIds.length ? pool.query<{ id: string; provider: string; name: string | null; last4: string; ownerId: string }>('SELECT id,provider,name,last4,"ownerId" FROM model_api_keys WHERE id=ANY($1::uuid[])', [keyIds]).then(result => result.rows) : [],
    mcpIds.length ? pool.query<{ id: string; name: string }>('SELECT id,name FROM personal_mcp_servers WHERE id=ANY($1::uuid[])', [mcpIds]).then(result => result.rows) : [],
    usesE2b ? pool.query<{ last4: string }>('SELECT last4 FROM user_e2b_keys WHERE "userId"=$1', [viewerId]).then(result => result.rows[0] ?? null) : null,
  ])
  return {
    workspace: workspace ? { name: workspace.name } : null,
    people: Object.fromEntries(users.map(user => [user.id, { name: user.name || user.email || '', image: user.image, you: user.id === viewerId }])),
    devices: Object.fromEntries(devices.map(device => [device.id, { name: device.name, kind: deviceMachineKind(device) }])),
    subscriptions: Object.fromEntries(subscriptions.map(row => [row.id, { provider: row.provider === 'codex' ? 'codex' : 'claude', account: row.ownerId === viewerId ? row.accountLabel : null, mine: row.ownerId === viewerId }])),
    apiKeys: Object.fromEntries(keys.map(row => [row.id, { provider: row.provider, name: row.name, last4: row.ownerId === viewerId ? row.last4 : null, mine: row.ownerId === viewerId }])),
    mcp: Object.fromEntries(mcp.map(row => [row.id, { name: row.name }])),
    e2b: e2b ? { last4: e2b.last4 } : null,
  }
}
