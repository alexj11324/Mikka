import 'server-only'
import { sql } from 'drizzle-orm'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import type { ResourceExecutor } from './store'
import { audienceChange, readableAccounts, rechain, type AccessLink, type AudienceChange } from './audience'
import { requireAccessConfirmation } from './confirm-gate'

/**
 * confirmAccess: a relation edit that changes who can read a resource must be
 * confirmed before it is written (ALE-26). The readable audience comes from the
 * same ancestor chain `mikka_resource_acl_allowed` walks, computed before and
 * after the edit; a changed audience is refused until the person confirms.
 */

type ChainRow = { root: string; kind: string; id: string; ownerId: string | null; visibility: AccessLink['visibility']; grants: string[] | null }

/**
 * The ancestor chain of each reference, resource first and root last, in one
 * statement. A missing policy yields no chain, which reads for nobody.
 */
export async function readAccessChains(executor: ResourceExecutor, references: readonly { kind: string; id: string }[]): Promise<Map<string, AccessLink[]>> {
  const chains = new Map<string, AccessLink[]>()
  if (!references.length) return chains
  const roots = sql.join(references.map(({ kind, id }) => sql`(${kind}::text,${id}::uuid)`), sql`, `)
  const { rows } = await executor.execute<ChainRow>(sql`
    with recursive chain as (
      select p.kind as root_kind,p.id as root_id,p.kind,p.id,p."ownerId",p.visibility,p."parentKind",p."parentId",0 as depth,array[p.kind||':'||p.id::text] as path,false as cycle
        from resource_access_policies p where (p.kind,p.id) in (${roots})
      union all
      select c.root_kind,c.root_id,p.kind,p.id,p."ownerId",p.visibility,p."parentKind",p."parentId",c.depth+1,c.path||(p.kind||':'||p.id::text),(p.kind||':'||p.id::text)=any(c.path)
        from chain c join resource_access_policies p on p.kind=c."parentKind" and p.id=c."parentId" where c.depth<32 and not c.cycle
    )
    select c.root_kind||':'||c.root_id as root,c.kind,c.id,c."ownerId",c.visibility,
      (select array_agg(distinct g."subjectId") from resource_access_grants g
        where g."resourceKind"=c.kind and g."resourceId"=c.id and g."subjectKind"='account'
          and 'canReadContent'=any(g.capabilities) and (g."expiresAt" is null or g."expiresAt">statement_timestamp())) as grants
    from chain c order by c.root_kind,c.root_id,c.depth`)
  for (const row of rows) {
    const link = { kind: row.kind, id: row.id, ownerId: row.ownerId, visibility: row.visibility, grants: row.grants ?? [] }
    const chain = chains.get(row.root)
    if (chain) chain.push(link)
    else chains.set(row.root, [link])
  }
  return chains
}

/** The tenant's active members: a shared link admits exactly these accounts. */
export async function activeWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(sql`${workspaceMembers.workspaceId}=${workspaceId}::uuid and ${workspaceMembers.status}='active'`)
  return rows.map(row => row.userId)
}

/** Move one resource's ancestry: under `parent`, or under nothing. */
export type AccessMove = { reference: { kind: 'task'; id: string }; parent: { kind: string; id: string } | null }

/**
 * How each moved resource's readable audience would change. Call inside the
 * transaction holding the policy locks, so the before and after reads see one
 * ancestry and a confirmation covers exactly what would be written. A resource
 * that still reads for the same accounts reports `changed: false`.
 */
export async function observeAudienceChanges(executor: ResourceExecutor, workspaceId: string, moves: readonly AccessMove[]): Promise<Map<string, AudienceChange>> {
  if (!moves.length) return new Map()
  const members = await activeWorkspaceMemberIds(workspaceId)
  // One read for every resource and every distinct parent, so the chain of each
  // is taken from the same snapshot.
  const parents = new Map<string, { kind: string; id: string }>()
  for (const move of moves) if (move.parent) parents.set(`${move.parent.kind}:${move.parent.id}`, move.parent)
  const chains = await readAccessChains(executor, [...moves.map(move => move.reference), ...parents.values()])
  return new Map(moves.map(({ reference, parent }): [string, AudienceChange] => {
    const before = chains.get(`${reference.kind}:${reference.id}`) ?? []
    const parentChain = parent ? chains.get(`${parent.kind}:${parent.id}`) ?? [] : null
    return [`${reference.kind}:${reference.id}`, audienceChange(before, rechain(before, parentChain), members)]
  }))
}

/** The accounts that can read a reference now, for a caller that reports a change. */
export async function readableAccountIds(executor: ResourceExecutor, workspaceId: string, reference: { kind: string; id: string }): Promise<string[]> {
  const members = await activeWorkspaceMemberIds(workspaceId)
  return [...readableAccounts((await readAccessChains(executor, [reference])).get(`${reference.kind}:${reference.id}`) ?? [], members)].sort()
}

/**
 * Refuse a set of moves before any of their side effects run. Call this before
 * a step that cannot be rolled back (stopping runs on another pool), and again
 * where the policies are written; both reads see the same locks.
 */
export async function assertAccessConfirmation(executor: ResourceExecutor, workspaceId: string,
  moves: readonly AccessMove[], confirmAccess: boolean): Promise<void> {
  requireAccessConfirmation((await observeAudienceChanges(executor, workspaceId, moves)).values(), confirmAccess)
}
