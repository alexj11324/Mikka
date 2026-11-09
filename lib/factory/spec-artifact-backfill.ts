import type { Pool } from 'pg';
import { z } from 'zod';
import { ExecutionIdentityError } from '../execution-identity';
import { factoryChanged } from '../live/factory';
import { FactoryError } from './contract';
import { factoryEventId } from './event-id';
import { withFactoryBackgroundWorkspace } from './background-workspace';
import { syncFactorySpecArtifact } from './spec-artifact';
import type { createFactoryStore } from './store';

export const factorySpecBackfillCursorSchema = z.object({
  through: z.string().datetime(), afterId: z.uuid().nullable(),
}).strict();
export type FactorySpecBackfillCursor = z.infer<typeof factorySpecBackfillCursorSchema>;
export interface FactorySpecBackfillOptions {
  limit?: number;
  cursor?: FactorySpecBackfillCursor;
  /** Inspection is the default. The operator explicitly opts into writes. */
  dryRun?: boolean;
}

/** One bounded operator-requested batch. The cursor freezes the completion
 * cutoff; it is not a scheduler. Each historical attempt uses the same current
 * owner/Bot/source/issue boundary and grant checks as the normal writer. */
export async function backfillFactorySpecArtifacts(
  pool: Pool,
  store: Pick<ReturnType<typeof createFactoryStore>, 'lockTask'>,
  userId: string,
  options: FactorySpecBackfillOptions = {},
) {
  const limit = options.limit ?? 50, dryRun = options.dryRun !== false;
  if (!userId.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new FactoryError('factoryInvalid');
  const { rows: [{ now }] } = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const parsed = factorySpecBackfillCursorSchema.safeParse(options.cursor ?? { through: now.toISOString(), afterId: null });
  if (!parsed.success || Date.parse(parsed.data.through) > now.getTime()) throw new FactoryError('factoryInvalid');
  const cursor = parsed.data;
  const { rows } = await pool.query<{ attemptId: string; taskId: string }>(`SELECT attempt.id AS "attemptId",task.id AS "taskId"
    FROM factory_attempts attempt JOIN factory_tasks task ON task.id=attempt."taskId"
    WHERE task."userId"=$1 AND attempt.stage='spec' AND attempt.status='passed'
      AND ($2::uuid IS NULL OR attempt.id>$2::uuid)
      AND COALESCE(attempt."finishedAt",attempt."createdAt")<=$3::timestamptz
    ORDER BY attempt.id LIMIT $4`, [userId, cursor.afterId, cursor.through, limit + 1]);
  const candidates = rows.slice(0, limit);
  const result = { mode: dryRun ? 'dry-run' as const : 'apply' as const, cursor, scanned: candidates.length,
    created: 0, wouldCreate: 0, existing: 0, skipped: { unauthorized: 0, sourceUnavailable: 0 },
    nextCursor: rows.length > limit ? { through: cursor.through, afterId: candidates.at(-1)!.attemptId } : null };
  for (const candidate of candidates) {
    try {
      // The persisted task selects the WS/member lease before APP checkout.
      // The original store rechecks every source/binding under its own locks.
      await withFactoryBackgroundWorkspace(pool, userId, { kind: 'task', id: candidate.taskId }, async () => {
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          const current = await store.lockTask(tx, userId, candidate.taskId);
          const task = { ...current, attemptId: candidate.attemptId, stage: 'spec' as const, status: 'passed' as const };
          const artifactId = factoryEventId('spec-artifact', `${task.id}:${task.attemptId}`);
          const { rows: [{ exists }] } = await tx.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM artifacts WHERE id=$1) AS exists', [artifactId]);
          const ref = await syncFactorySpecArtifact(tx, task, { historical: true, dryRun });
          if (!ref) result.skipped.sourceUnavailable++;
          else if (exists) result.existing++;
          else if (dryRun) result.wouldCreate++;
          else result.created++;
          if (ref && !dryRun) await factoryChanged(tx, current);
          await tx.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        } catch (error) { await tx.query('ROLLBACK'); throw error; }
        finally { tx.release(); }
      });
    } catch (error) {
      if (error instanceof ExecutionIdentityError || error instanceof FactoryError && error.code === 'factoryNotFound')
        result.skipped.unauthorized++;
      else throw error;
    }
  }
  return result;
}
