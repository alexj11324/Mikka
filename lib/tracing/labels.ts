import { AsyncLocalStorage } from 'node:async_hooks'

// The `mikka.route` label in force for the code running now
// (docs/operations/tracing.md, "Background work"). Shared by the span
// processor (lib/tracing/spans.ts) and the db_sample log line
// (lib/db/egress-sample.ts). No OpenTelemetry import, so either can load it.

/**
 * The route template, Server Action or background job the current code runs
 * under, set by lib/request-log.ts, withDatabaseOperation and runJob. Shared
 * through a global key, so every bundled copy of these modules sees one store.
 */
export const routeScope: AsyncLocalStorage<string> = ((globalThis as Record<symbol, unknown>)[Symbol.for('mikka.requestRoute')] ??= new AsyncLocalStorage<string>()) as AsyncLocalStorage<string>

type StepContext = { stepMetadata?: { stepName?: unknown }; workflowMetadata?: { workflowName?: unknown } }

/**
 * The Workflow SDK runs every `'use step'` body inside this process-wide
 * AsyncLocalStorage (`@workflow/core` step/context-storage.js; it is what
 * `getStepMetadata()` reads). Reading it here labels all steps without
 * touching each one.
 */
const STEP_CONTEXT = Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE')

/** `step//./workflows/run-publication/steps//publishResult` → `publishResult`. Identifier characters only. */
function shortName(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name) return undefined
  const short = (name.split('//').at(-1) ?? '').split('/').at(-1)?.replace(/[^A-Za-z0-9_.-]/g, '')
  return short || undefined
}

/** `workflow:<workflow>/<step>` while a Workflow step body runs, else undefined. */
export function workflowStepRoute(): string | undefined {
  try {
    const store = ((globalThis as Record<symbol, unknown>)[STEP_CONTEXT] as AsyncLocalStorage<StepContext> | undefined)?.getStore()
    const step = shortName(store?.stepMetadata?.stepName)
    return step ? `workflow:${shortName(store?.workflowMetadata?.workflowName) ?? 'unknown'}/${step}` : undefined
  } catch { return undefined }
}

/** The label for a query issued now: the innermost request, action or job label, else the Workflow step. */
export function currentRoute(): string | undefined {
  return routeScope.getStore() ?? workflowStepRoute()
}
