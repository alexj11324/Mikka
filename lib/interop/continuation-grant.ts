/**
 * Continuing an ended thread starts a run on its owner's subscription, quota
 * and machine, so a peer needs the owner's explicit grant (decision
 * 2026-11-19-2200 §3). `canSteer` from `shared` visibility or a parent does not
 * count: only an unexpired `canSteer` grant row on the thread's root run for one
 * of the sender's subjects (its own run, Bot or service, or the member account
 * behind a run or Bot).
 */
export type ContinuationSubject = { kind: 'account' | 'bot' | 'run' | 'service'; id: string }

export async function hasExplicitContinuationGrant(executor: { query: (text: string, values: unknown[]) => Promise<{ rowCount: number | null }> },
  rootRunId: string, subjects: readonly ContinuationSubject[]): Promise<boolean> {
  if (!subjects.length) return false
  const { rowCount } = await executor.query(`SELECT 1 FROM resource_access_grants g
    JOIN unnest($2::text[],$3::text[]) AS s(kind,id) ON s.kind=g."subjectKind" AND s.id=g."subjectId"
    WHERE g."resourceKind"='thread' AND g."resourceId"=$1 AND 'canSteer'=ANY(g.capabilities)
      AND (g."expiresAt" IS NULL OR g."expiresAt">statement_timestamp()) LIMIT 1`,
  [rootRunId, subjects.map(subject => subject.kind), subjects.map(subject => subject.id)])
  return Boolean(rowCount)
}

/** Thrown as the cause of a refused continuation. */
export class ContinuationGrantRequired extends Error {
  constructor() { super('continuationGrantRequired'); this.name = 'ContinuationGrantRequired' }
}
