import { z } from 'zod';
import type { createFactoryDispatchRecovery } from './dispatch-recovery';

type Recovery = ReturnType<typeof createFactoryDispatchRecovery>;
const noStore = { 'Cache-Control': 'private, no-store' };

/** Shared by GET .../dispatch and POST .../dispatch/cloud; userId is the signed-in browser session's. */
export async function handleFactoryDispatchRecovery(recovery: Recovery, input: { userId: string | null; taskId: string; action: 'status' | 'cloud' }) {
  if (!input.userId) return { status: 401, body: { error: 'authRequired' }, headers: noStore };
  const id = z.uuid().safeParse(input.taskId);
  if (!id.success) return { status: 422, body: { error: 'factoryInvalid' }, headers: noStore };
  const taskId = id.data.toLowerCase();
  if (input.action === 'cloud') return { ...await recovery.switchToCloud(input.userId, taskId), headers: noStore };
  const status = await recovery.status(input.userId, taskId);
  return status ? { status: 200, body: status as unknown as Record<string, unknown>, headers: noStore } : { status: 404, body: { error: 'factoryNotFound' }, headers: noStore };
}
