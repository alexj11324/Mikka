import { FactoryError } from "./contract";
import type { FactoryDispatchInput, FactoryDispatchResult } from "./dispatch";

export type FactoryDispatchFn = (userId: string, input: FactoryDispatchInput) => Promise<FactoryDispatchResult>;
export interface FactoryDispatchRequest {
  userId: string | null;
  origin: string | null;
  url: string;
  body: unknown;
  /** Same gate as the Coordinator dispatch tool: issue mutations + routing + lifecycle flags. */
  enabled: boolean;
}

/**
 * POST /api/factory/tasks: non-LLM dispatch entry, modeled on Devin's
 * "create session". It reuses the exact dispatch used by the Coordinator tool
 * (factoryRuntimeForBot(null).dispatch), so permissions (session-owned issue),
 * the factory_events audit receipt and replay/idempotency are identical.
 */
export async function handleFactoryDispatch(
  dispatch: () => Promise<FactoryDispatchFn>,
  req: FactoryDispatchRequest,
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
    const result = await (await dispatch())(req.userId, req.body as FactoryDispatchInput);
    return {
      status: result.replayed ? 200 : 201,
      body: {
        taskId: result.task.id,
        runId: result.runId,
        stage: result.task.stage,
        status: result.task.status,
        replayed: result.replayed,
        binding: result.binding,
        task: result.task,
      },
    };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    const status =
      error.code === "factoryNotFound" ? 404
        : error.code === "factoryInvalid" ? 422
          : error.code === "factoryLifecycleUnavailable" ? 404
            : 409;
    return { status, body: { error: error.code } };
  }
}
