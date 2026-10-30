import { FactoryError, type FactoryBinding } from "./contract";
import { maskFactoryNote } from "./note-mask";
import type { FactorySnapshot } from "./store";

export type FactoryRouteFn = (userId: string, input: unknown) => Promise<FactorySnapshot>;
export interface FactoryRouteRequest {
  userId: string | null;
  origin: string | null;
  url: string;
  body: unknown;
  /** factoryRouteEnabled(): same flags as the Coordinator route tool. */
  enabled: boolean;
}

/** Issue mutations AND MIKKA_FACTORY_ROUTING_ENABLED=1 AND MIKKA_FACTORY_LIFECYCLE_ENABLED=1 (literal "1"). */
export function factoryRouteEnabled(issueMutations: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return issueMutations && env.MIKKA_FACTORY_ROUTING_ENABLED === "1" && env.MIKKA_FACTORY_LIFECYCLE_ENABLED === "1";
}

/** Human text the ledger persists (factory_tasks.route/reason, factory_events.request) is masked first. */
export function maskRouteText(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (typeof out.rationale === "string") out.rationale = maskFactoryNote(out.rationale);
  for (const key of ["missingInformation", "missingPermissions"] as const) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((item) => (typeof item === "string" ? maskFactoryNote(item) : item));
  }
  return out;
}

const binding = (task: FactorySnapshot["task"]): FactoryBinding => ({
  taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: task.revision,
});

/**
 * POST /api/factory/tasks/route (BE-10b): route an issue into Factory without an
 * LLM, through the same store.route the Coordinator tool uses (session-owned
 * issue, coordinator source event, factory_events receipt).
 *
 * Body (routeSchema, strict): { issueId, eventId, sourceEventId, rationale,
 * missingInformation?, missingPermissions?, needsSpec? }. sourceEventId must be the
 * caller's own user_message Coordinator event for this issue (or unscoped).
 *
 * Idempotency: one task per (user, issue, sourceEventId). Replaying the same
 * eventId with the same body returns the stored snapshot (200); the same
 * eventId with another body is 409 factoryReplayMismatch; a new eventId for an
 * already-routed source is 409 factoryRouteExists. Both new and replayed routes
 * answer 200 because store.route does not report which one happened.
 * Response: { taskId, stage, status, binding, task }. Use `binding` with
 * POST /api/factory/tasks to dispatch.
 */
export async function handleFactoryRoute(
  route: () => Promise<FactoryRouteFn>,
  req: FactoryRouteRequest,
): Promise<{ status: number; body: unknown }> {
  if (!req.userId) return { status: 401, body: { error: "authRequired" } };
  try {
    const origin = new URL(req.origin ?? "");
    if (origin.origin !== new URL(req.url).origin || !["http:", "https:"].includes(origin.protocol)) throw new Error("origin");
  } catch {
    return { status: 403, body: { error: "originRejected" } };
  }
  if (!req.enabled) return { status: 404, body: { error: "factoryLifecycleUnavailable" } };
  try {
    const result = await (await route())(req.userId, maskRouteText(req.body));
    return {
      status: 200,
      body: { taskId: result.task.id, stage: result.task.stage, status: result.task.status, binding: binding(result.task), task: result.task },
    };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    const status =
      error.code === "factoryNotFound" || error.code === "factoryLifecycleUnavailable" ? 404
        : error.code === "factoryInvalid" ? 422
          : 409;
    return { status, body: { error: error.code } };
  }
}
