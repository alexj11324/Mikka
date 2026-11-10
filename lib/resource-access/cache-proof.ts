import 'server-only'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'

/** A cache discriminator, never a bearer capability. Compute it only after
 * fresh Workspace/Enterprise authorization. Hidden resource IDs, titles and
 * counts never leave the database. A lost parent or an expired grant changes
 * the visible permission set even if no live push could be delivered. */
export async function readResourceAccessProof(userId: string, workspaceId: string, query: Pick<PoolClient, 'query'> = pool) {
  const { rows: [row] } = await query.query<{ accessProof: string; accessExpiresAt: Date | null; observedAt: Date }>(`WITH visible AS MATERIALIZED (
    SELECT kind,id,revision FROM resource_access_policies p WHERE p."workspaceId"=$2
      AND mikka_resource_acl_allowed('account',$1,$2,p.kind,p.id,'canReadContent')
  ) SELECT encode(sha256(convert_to(coalesce((SELECT string_agg(kind||':'||id::text||':'||revision::text,',' ORDER BY kind,id) FROM visible),''),'UTF8')),'hex') AS "accessProof",
    (SELECT min(g."expiresAt") FROM resource_access_grants g JOIN visible p ON p.kind=g."resourceKind" AND p.id=g."resourceId"
      WHERE g."subjectKind"='account' AND g."subjectId"=$1 AND g."expiresAt">clock_timestamp()) AS "accessExpiresAt",statement_timestamp() AS "observedAt"`, [userId,workspaceId])
  return { accessProof: row.accessProof, accessExpiresAt: row.accessExpiresAt?.toISOString() ?? null,
    accessExpiresAfterMs: row.accessExpiresAt ? Math.max(0, row.accessExpiresAt.getTime()-row.observedAt.getTime()) : null }
}
