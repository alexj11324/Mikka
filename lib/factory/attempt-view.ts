import type { FactoryStage } from './contract';
import { maskFactoryNote } from './note-mask';
import { publicFactoryStage, type FactoryPublicStage } from './public-flow';

export type FactoryAttemptRole = 'plan' | 'implement' | 'review' | 'fix' | null;

/** Narrow columns from an already-authorized task, not the attempt's full output. */
export interface FactoryAttemptViewSource {
  id: string;
  stage: FactoryStage;
  position: number;
  runId: string | null;
  reason: string;
  summary?: string | null;
  completionSummary?: string | null;
  requestEpoch?: string | null;
  reasonCode?: string | null;
}

/** Host transition receipts that created an attempt, scoped to the same task.
 * Modern revision bindings omit the old attempt id; position is the canonical
 * predecessor in that case. Do not pass finish/bind_run snapshots as creation. */
export interface FactoryAttemptTransitionSource {
  attemptId: string;
  previousAttemptId?: string | null;
  action?: string | null;
  kind?: string | null;
}

export interface FactoryAttemptPresentation {
  stage: FactoryPublicStage;
  role: FactoryAttemptRole;
  title: string | null;
  /** The earlier implementation revised by this fix, not a review or infra retry. */
  revisionOf: string | null;
}

/** Mask before taking the first line so truncation cannot cut a credential mask. */
export function factoryAttemptTitle(...sources: readonly (string | null | undefined)[]): string | null {
  for (const source of sources) {
    if (typeof source !== 'string' || !source.trim()) continue;
    const first = maskFactoryNote(source).split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (!first) continue;
    const line = first.replace(/^#{1,6}\s+/, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
    if (line) return [...line].slice(0, 200).join('');
  }
  return null;
}

const roleForStage = (stage: FactoryStage): FactoryAttemptRole => stage === 'spec' ? 'plan'
  : stage === 'execute' ? 'implement' : ['review', 'verify', 'monitor'].includes(stage) ? 'review' : null;
const CREATES_ATTEMPT = new Set(['repair', 'retry', 'adopt_retry', 'advance', 'resolve']);
const REPAIR_FAILURES = new Set(['run_failed', 'factoryEvidenceMismatch']);

/** One stage/role/title mapping for the runtime sidebar and any attempt list.
 * Ordinals are never interpreted as repairs: provider/device retries and a new
 * owner request also increment them. Missing history remains an implementation. */
export function projectFactoryAttempts(
  attempts: readonly FactoryAttemptViewSource[],
  transitions: readonly FactoryAttemptTransitionSource[] = [],
): Map<string, FactoryAttemptPresentation> {
  const ordered = [...attempts].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const byId = new Map(ordered.map(attempt => [attempt.id, attempt]));
  const created = new Map<string, FactoryAttemptTransitionSource>();
  for (const transition of transitions) {
    if (!byId.has(transition.attemptId) || created.has(transition.attemptId) ||
        (transition.kind !== 'request_epoch' && !CREATES_ATTEMPT.has(transition.action ?? ''))) continue;
    created.set(transition.attemptId, transition);
  }
  const result = new Map<string, FactoryAttemptPresentation>();
  let previous: FactoryAttemptViewSource | undefined;
  const executions = new Map<string | null, string>();
  for (const attempt of ordered) {
    const transition = created.get(attempt.id);
    const explicitPrevious = transition?.previousAttemptId ? byId.get(transition.previousAttemptId) : undefined;
    const parent = explicitPrevious?.position === attempt.position - 1 ? explicitPrevious
      : previous?.position === attempt.position - 1 ? previous : undefined;
    const sameEpoch = Boolean(parent && (parent.requestEpoch ?? null) === (attempt.requestEpoch ?? null));
    const inherited = sameEpoch && parent ? result.get(parent.id) : undefined;
    const epoch = attempt.requestEpoch ?? null;
    let role = roleForStage(attempt.stage), revisionOf: string | null = null;
    if (attempt.stage === 'execute' && transition?.kind !== 'request_epoch') {
      const repair = sameEpoch && (transition?.action === 'repair' ||
        (transition?.action === 'retry' && REPAIR_FAILURES.has(parent?.reasonCode ?? '')));
      if (repair) {
        role = 'fix';
        revisionOf = executions.get(epoch) ?? null;
      } else if (sameEpoch && parent?.stage === 'execute' && ['adopt_retry', 'retry'].includes(transition?.action ?? '')) {
        role = inherited?.role ?? role;
        revisionOf = inherited?.revisionOf ?? null;
      }
    }
    result.set(attempt.id, {
      // A cancelled attempt still ran its original stage; status is a separate field.
      stage: publicFactoryStage(attempt.stage, 'pending', false), role,
      title: factoryAttemptTitle(attempt.summary, attempt.completionSummary, attempt.reason), revisionOf,
    });
    if (attempt.stage === 'execute' && attempt.runId) executions.set(epoch, attempt.id);
    previous = attempt;
  }
  return result;
}
