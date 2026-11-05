import { z } from 'zod';
import type { Pool } from 'pg';
import type { FactoryHuman } from './approval-contract';
import { FactoryError } from './contract';
import { AgentProfileError } from './agent-profile-definition';
import type { createFactoryStore } from './store';
import { readFactoryFlow } from './public-flow';
import { factorySpecApprovalRequest, type createFactorySpecApproval } from './spec-approval';

export async function handleFactoryFlow(pool: Pool, store: ReturnType<typeof createFactoryStore>, approveSpec: ReturnType<typeof createFactorySpecApproval>, req: {
  actor: FactoryHuman | null; authorization: string | null; method: string; taskId: string; origin: string | null; url: string; body?: unknown;
}) {
  if (!req.actor || req.authorization) return { status: 401, body: { error: 'factoryHumanRequired' } };
  if (!z.uuid().safeParse(req.taskId).success) return { status: 404, body: { error: 'factoryNotFound' } };
  if (!['GET','POST'].includes(req.method)) return { status: 405, body: { error: 'methodNotAllowed' } };
  if (req.method === 'POST') {
    try { if (new URL(req.origin ?? '').origin !== new URL(req.url).origin) return { status: 403, body: { error: 'originRejected' } }; }
    catch { return { status: 403, body: { error: 'originRejected' } }; }
  }
  try {
    if (req.method === 'POST') {
      const parsed = z.object({ operation: z.literal('approve_spec'), input: factorySpecApprovalRequest }).strict().safeParse(req.body);
      if (!parsed.success || parsed.data.input.binding.taskId !== req.taskId) return { status: 422, body: { error: 'factoryInvalid' } };
      return { status: 200, body: await approveSpec(req.actor,parsed.data.input) };
    }
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const task = await store.readTask(tx,req.actor.userId,req.taskId);
      const flow = await readFactoryFlow(tx,task);
      await tx.query('COMMIT');
      return { status: 200, body: flow };
    } catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  } catch (error) {
    if (error instanceof AgentProfileError) return { status:error.status, body:{error:error.code,...(error.detail ? {detail:error.detail} : {})} };
    if (!(error instanceof FactoryError)) throw error;
    return { status: error.code === 'factoryNotFound' ? 404 : error.code === 'factoryInvalid' ? 422 : 409, body: { error: error.code, ...(error.detail ? { detail: error.detail } : {}) } };
  }
}
