import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { bindingSchema, FactoryError, type FactoryBinding, type FactoryStage } from './contract';
import { factoryEventId } from './event-id';
import type { createFactoryStore, FactoryTask, FactorySnapshot } from './store';

export const factoryDispatchSchema = z.object({
  binding: bindingSchema,
  agentId: z.uuid().transform(v => v.toLowerCase()),
  deviceRepoId: z.uuid().transform(v => v.toLowerCase()),
  note: z.string().trim().max(10000).optional(),
}).strict();
export type FactoryDispatchInput = z.infer<typeof factoryDispatchSchema>;
export type FactoryQueue = (tx: PoolClient, userId: string, input: {
  issueId: string; agentId: string; deviceRepoId: string; note?: string;
}, botId: string | null) => Promise<{ runId: string }>;
/** Installed by the owning consumer; no model may select a callback or gate. */
export interface FactoryDispatchAdapters {
  configure: Partial<Record<FactoryStage, (tx: PoolClient, task: FactoryTask, runId: string) => Promise<void>>>;
  freeze: (tx: PoolClient, task: FactoryTask, runId: string) => Promise<void>;
}
export interface FactoryDispatchResult extends FactorySnapshot {
  runId: string; replayed: boolean; binding: FactoryBinding;
}
export const factoryBinding = (task: FactoryTask): FactoryBinding => ({
  taskId: task.id, issueId: task.issueId, attemptId: task.attemptId,
  candidateId: task.candidateId, revision: task.revision,
});
function fail(code: string): never { throw new FactoryError(code); }
/** Task -> issue/access -> run. The existing queue writes through this transaction.
 * Ledger, queue, server configuration, frozen definition and binding commit together. */
export function createFactoryDispatch(pool: Pool, store: ReturnType<typeof createFactoryStore>, queue: FactoryQueue, adapters: FactoryDispatchAdapters) {
  return async (userId: string, raw: FactoryDispatchInput, existing?: PoolClient): Promise<FactoryDispatchResult> => {
    const parsed = factoryDispatchSchema.safeParse(raw);
    if (!parsed.success) fail('factoryInvalid');
    const input = parsed.data, { binding } = input;
    const tx = existing ?? await pool.connect();
    try {
      if (!existing) await tx.query('BEGIN');
      const task = await store.lockTask(tx, userId, binding.taskId);
      if (task.issueId !== binding.issueId) fail('factoryNotFound');
      if (['cancelled','revoked'].includes(task.status)) fail('factoryStopped');
      const eventId = factoryEventId('dispatch-v2', binding.attemptId);
      const { rows: [receipt] } = await tx.query<{ same: boolean; result: FactoryDispatchResult }>(
        'SELECT request=$3::jsonb AS same,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
        [task.id,eventId,JSON.stringify(input)]);
      if (receipt) {
        if (!receipt.same) fail('factoryReplayMismatch');
        if (task.revision !== receipt.result.binding.revision || task.attemptId !== binding.attemptId || task.candidateId !== binding.candidateId) fail('factoryStale');
        if (!existing) await tx.query('COMMIT');
        return { ...receipt.result, replayed: true };
      }
      if (task.revision !== binding.revision || task.attemptId !== binding.attemptId || task.candidateId !== binding.candidateId) fail('factoryStale');
      if (task.status !== 'pending' || !['spec','execute','review','verify','monitor'].includes(task.stage)) fail('factoryTransition');
      const configure = adapters.configure[task.stage];
      if (!configure) fail('factoryDispatchAdapterRequired');
      const queued = await queue(tx,userId,{issueId:task.issueId,agentId:input.agentId,deviceRepoId:input.deviceRepoId,note:input.note},task.botId);
      await configure(tx,task,queued.runId);
      await adapters.freeze(tx,task,queued.runId);
      const { rows: [run] } = await tx.query('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE',[queued.runId]);
      if (!run || run.userId !== userId || run.issueId !== task.issueId || run.botId !== task.botId || run.agentId !== input.agentId || run.deviceRepoId !== input.deviceRepoId || run.status !== 'queued' || run.stopRequestedAt || !run.agentDefinition) fail('factoryRunMismatch');
      const state = await store.apply(userId,binding,binding.attemptId,{action:'bind_run',runId:run.id},tx);
      const result = {...state,runId:run.id as string,replayed:false,binding:factoryBinding(state.task)};
      await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',[task.id,eventId,JSON.stringify(input),JSON.stringify(result)]);
      if (!existing) await tx.query('COMMIT');
      return result;
    } catch (error) { if (!existing) await tx.query('ROLLBACK'); throw error; }
    finally { if (!existing) tx.release(); }
  };
}
