import type { PoolClient } from 'pg';
import { FactoryError, type FactoryStage } from './contract';
import type { FactoryGate, FactoryTask, createFactoryStore } from './store';
import type { FactoryDispatchAdapters } from './dispatch';

export const FACTORY_CONSUMER_CONTRACT_VERSION = 1 as const;
export type FactoryCheckStage = Extract<FactoryStage, 'review' | 'verify' | 'monitor'>;
/** Host-installed only. These functions are never parsed from a request or report.
 * configure runs before freeze/bind; reconcile owns no commit and must use store.apply.
 * validateClaim rechecks frozen assignment and publication/permission availability.
 */
export interface FactoryConsumerAdapter {
  stage: FactoryCheckStage;
  configure: NonNullable<FactoryDispatchAdapters['configure'][FactoryCheckStage]>;
  validateClaim(tx: PoolClient, task: FactoryTask, runId: string): Promise<Record<string, unknown>>;
  gate: FactoryGate;
  reconcile(tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, any>): Promise<unknown>;
}

/** Atomic registration: no partially usable phase, duplicate phase, or permissive fallback. */
export function composeFactoryConsumers(adapters: readonly FactoryConsumerAdapter[] = []) {
  const indexed = new Map<FactoryCheckStage, FactoryConsumerAdapter>();
  for (const adapter of adapters) {
    if (!['review','verify','monitor'].includes(adapter.stage) || indexed.has(adapter.stage) ||
        ['configure','validateClaim','gate','reconcile'].some(key => typeof adapter[key as keyof FactoryConsumerAdapter] !== 'function'))
      throw new FactoryError('factoryConsumerRegistrationInvalid');
    indexed.set(adapter.stage, adapter);
  }
  return {
    configure: Object.fromEntries([...indexed].map(([stage, adapter]) => [stage, adapter.configure])) as FactoryDispatchAdapters['configure'],
    gates: Object.fromEntries([...indexed].map(([stage, adapter]) => [stage, adapter.gate])),
    consumers: Object.fromEntries([...indexed].map(([stage, adapter]) => [stage, adapter.reconcile])),
    validateClaim: async (tx: PoolClient, task: FactoryTask, runId: string) => {
      const adapter = indexed.get(task.stage as FactoryCheckStage);
      if (!adapter) throw new FactoryError('factoryDispatchAdapterRequired');
      return adapter.validateClaim(tx, task, runId);
    },
  };
}

/** Binding checks do NOT authenticate an artifact. Only a trusted adapter reader may
 * supply this envelope after verifying its source and digest. Never call with worker JSON.
 * expiresAt/maxAge are backend policy, not a worker-selected validity window.
 */
export interface FactoryVerifiedArtifactBinding {
  userId: string; botId: string | null; issueId: string; sourceEventId: string;
  taskId: string; attemptId: string; revision: number; candidateId: string;
  stage: FactoryCheckStage; runId: string; sessionId: string; sha: string;
  definitionDigest: string; artifactId: string; artifactDigest: string;
  observedAt: string; expiresAt: string;
}
export function assertFactoryArtifactBinding(
  task: FactoryTask,
  run: { id: string; userId: string; botId: string | null; issueId: string; sessionId: string | null; stopRequestedAt: unknown; definitionDigest: string },
  candidateSha: string,
  artifact: FactoryVerifiedArtifactBinding,
  policy: { now: number; maxAgeMs: number },
) {
  const observed = Date.parse(artifact.observedAt), expires = Date.parse(artifact.expiresAt);
  if (task.status !== 'running' || !task.candidateId || run.stopRequestedAt || !run.sessionId ||
      !['review','verify','monitor'].includes(task.stage) ||
      artifact.userId !== task.userId || artifact.botId !== task.botId || artifact.issueId !== task.issueId ||
      artifact.sourceEventId !== task.sourceEventId || artifact.taskId !== task.id || artifact.attemptId !== task.attemptId ||
      artifact.revision !== task.revision || artifact.candidateId !== task.candidateId || artifact.stage !== task.stage ||
      run.userId !== task.userId || run.botId !== task.botId || run.issueId !== task.issueId ||
      artifact.runId !== run.id || artifact.sessionId !== run.sessionId || artifact.sha !== candidateSha ||
      !run.definitionDigest || artifact.definitionDigest !== run.definitionDigest ||
      !artifact.artifactId.trim() || !/^[a-f0-9]{64}$/.test(artifact.artifactDigest) || !/^[a-f0-9]{40}$/.test(candidateSha) ||
      !Number.isFinite(policy.now) || !Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0 ||
      !Number.isFinite(observed) || !Number.isFinite(expires) || observed > policy.now || expires <= policy.now ||
      expires <= observed || policy.now - observed > policy.maxAgeMs)
    throw new FactoryError('factoryArtifactBindingInvalid');
}
