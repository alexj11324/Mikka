import { sql, type SQLWrapper } from 'drizzle-orm'
import type { ResourceAction, ResourceKind } from './contract'

/** Call only after the reader's fresh Workspace/Enterprise authorization.
 * SQL and imperative readers use the same DB function and ancestry rules. */
export function resourceAccessPredicate(userId: string, workspaceId: SQLWrapper | string, kind: ResourceKind,
  id: SQLWrapper | string, action: ResourceAction = 'canReadContent') {
  return sql<boolean>`mikka_resource_acl_allowed('account', ${userId}, ${workspaceId}, ${kind}, ${id}, ${action})`
}
