import { z } from "zod";
import { bindingSchema, FactoryError } from "./contract";
import type { createFactoryStore } from "./store";

export type FactoryStore = ReturnType<typeof createFactoryStore>;
export interface FactoryRequest {
  userId: string | null;
  method: string;
  taskId: string;
  origin: string | null;
  url: string;
  body?: unknown;
}
const controlSchema = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid(),
    action: z.enum(["cancel", "revoke", "retry", "repair"]),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();
/** 404 hides existence (no 403 leak for tasks you cannot see); a switched-off
 * feature is 503 so the UI can show "not available" instead of "missing". */
export function factoryListStatus(code: string) {
  if (code === "factoryNotFound") return 404;
  if (code === "factoryInvalid") return 422;
  if (code === "factoryForbidden" || code === "originRejected") return 403;
  if (code.endsWith("Unavailable")) return 503;
  return 409;
}
/** Read-only discovery; identity is always supplied by the session adapter. */
export async function handleFactoryList(
  store: FactoryStore,
  req: { userId: string | null; issueId: string | null },
): Promise<{ status: number; body: unknown }> {
  if (!req.userId) return { status: 401, body: { error: "authRequired" } };
  if (!z.uuid().safeParse(req.issueId).success)
    return { status: 422, body: { error: "factoryInvalid" } };
  try {
    return {
      status: 200,
      body: await store.listForIssue(req.userId, req.issueId!),
    };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    return { status: factoryListStatus(error.code), body: { error: error.code } };
  }
}
/** Session identity comes from the adapter. No runtime pass, dispatch or approval API. */
export async function handleFactory(
  store: FactoryStore,
  req: FactoryRequest,
): Promise<{ status: number; body: unknown }> {
  if (!req.userId) return { status: 401, body: { error: "authRequired" } };
  if (!z.uuid().safeParse(req.taskId).success)
    return { status: 404, body: { error: "factoryNotFound" } };
  if (req.method !== "GET" && req.method !== "POST")
    return { status: 405, body: { error: "methodNotAllowed" } };
  if (req.method === "POST") {
    try {
      const origin = new URL(req.origin ?? "");
      if (
        origin.origin !== new URL(req.url).origin ||
        !["http:", "https:"].includes(origin.protocol)
      )
        throw new Error("origin");
    } catch {
      return { status: 403, body: { error: "originRejected" } };
    }
  }
  try {
    if (req.method === "GET")
      return { status: 200, body: await store.read(req.userId, req.taskId) };
    const parsed = controlSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.binding.taskId !== req.taskId)
      return { status: 422, body: { error: "factoryInvalid" } };
    const { binding, eventId, action, reason } = parsed.data;
    return {
      status: 200,
      body: await store.apply(req.userId, binding, eventId, { action, reason }),
    };
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error;
    return {
      status:
        error.code === "factoryNotFound"
          ? 404
          : error.code === "factoryInvalid"
            ? 422
            : 409,
      body: { error: error.code },
    };
  }
}
