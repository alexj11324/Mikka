import type { WorkspaceQuery } from './identity'

/** Normal reads delete their response in finally. The existing reconciliation
 * sweep removes crash residues; no workspace-specific polling or resident job. */
export async function cleanupWorkspaceEphemera(database: WorkspaceQuery) {
  const requests = await database.query('DELETE FROM coding_workspace_requests WHERE "expiresAt"<=clock_timestamp()')
  const mentions = await database.query('DELETE FROM coding_workspace_mentions WHERE "expiresAt"<=clock_timestamp()')
  return { requests: requests.rowCount ?? 0, mentions: mentions.rowCount ?? 0 }
}
