import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { FactoryHuman } from './approval-contract';
import { FactoryError, factoryFlowVersion, revisionBindingSchema } from './contract';
import { factoryBinding } from './dispatch';
import { factoryEventId } from './event-id';
import type { createFactoryStore, FactoryCompletionDispatch } from './store';
import { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } from './transaction';

export const factorySpecApprovalRequest = z.object({ binding: revisionBindingSchema, eventId: z.uuid() }).strict();
/** Host-only actor, installed solely on the browser approval route. */
export function createFactorySpecApproval(pool: Pool, store: ReturnType<typeof createFactoryStore>, dispatch?: FactoryCompletionDispatch) {
  return async (actor: FactoryHuman, raw: unknown) => {
    if (!actor.userId || !actor.sessionId) throw new FactoryError('factoryHumanRequired');
    const parsed = factorySpecApprovalRequest.safeParse(raw);
    if (!parsed.success) throw new FactoryError('factoryInvalid');
    const input = parsed.data, tx = await pool.connect();
    let start: (() => Promise<void>) | undefined;
    let committed = false;
    try {
      await beginFactoryTransaction(tx);
      const task = await store.lockTask(tx, actor.userId, input.binding.taskId);
      const { rows: [prior] } = await tx.query('SELECT revision,result FROM factory_spec_approvals WHERE "taskId"=$1 AND "eventId"=$2', [task.id,input.eventId]);
      if (prior) {
        if (prior.revision !== input.binding.revision) throw new FactoryError('factoryReplayMismatch');
        await commitFactoryTransaction(tx);
        committed = true;
        return { ...prior.result, replayed: true };
      }
      if (task.revision !== input.binding.revision) throw new FactoryError('factoryStale');
      if (factoryFlowVersion(task) !== 2 || task.stage !== 'spec' || task.status !== 'passed') throw new FactoryError('factoryTransition');
      const { rows: [run] } = await tx.query(`SELECT r.id FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$3 AND r."issueId"=$4 WHERE a.id=$1 AND a."taskId"=$2 AND r.status='succeeded' AND r."stopReason"='submitted' AND r."sessionId" IS NOT NULL`,
        [task.attemptId,task.id,actor.userId,task.issueId]);
      if (!run) throw new FactoryError('factoryEvidenceRequired');
      await tx.query('INSERT INTO factory_spec_approvals ("taskId","attemptId","sourceEventId","eventId","userId","sessionDigest",revision) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [task.id,task.attemptId,task.sourceEventId,input.eventId,actor.userId,createHash('sha256').update(actor.sessionId).digest('hex'),task.revision]);
      const next = await store.apply(actor.userId, factoryBinding(task), factoryEventId('spec-approved',input.eventId),
        { action: 'advance', stage: 'execute', reason: 'The person approved the completed specification' }, tx);
      start = (await dispatch?.(tx,store,next.task,run)) ?? undefined;
      const current = await store.readTask(tx,actor.userId,task.id);
      const result = { binding: factoryBinding(current), stage: 'implement' as const, replayed: false };
      await tx.query('UPDATE factory_spec_approvals SET result=$2 WHERE "attemptId"=$1',[task.attemptId,JSON.stringify(result)]);
      await commitFactoryTransaction(tx);
      committed = true;
      if (start) await start();
      return result;
    } catch (error) { if (!committed) await rollbackFactoryTransaction(tx); throw error; }
    finally { forgetFactoryTransaction(tx); tx.release(); }
  };
}
