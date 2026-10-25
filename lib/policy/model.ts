import { randomUUID } from "node:crypto";
import { appendAudit, transaction } from "../audit/store";
import {
  admitModel,
  endpointSchema,
  PolicyError,
  type ModelRoute,
} from "./contract";
import type { PolicyStore } from "./store";

// #215 owns reservation/settlement. A caller cannot supply a permissive boolean.
// Until its atomic reservation adapter is integrated, enrolled traffic fails closed.
export async function authorizeModelRequest(
  store: PolicyStore,
  userId: string,
  route: ModelRoute,
) {
  const result = await transaction(store.pool, async (tx) => {
    const bindings = await store.bindings(tx, userId);
    if (!bindings.length) return null;
    let error = new PolicyError("policyBudgetUnavailable", 503);
    try {
      for (const b of bindings) admitModel(b.effective, route);
    } catch (failure) {
      if (!(failure instanceof PolicyError)) throw failure;
      error = failure;
    }
    for (const b of bindings)
      await appendAudit(tx, b.signed.payload.workspaceId, {
        actorId: userId,
        actorType: "system",
        resourceId: b.signed.payload.hash,
        action: "policy.model",
        outcome: "denied",
        reason: error.code,
        requestId: randomUUID(),
      });
    return error;
  });
  if (result) throw result;
}
export function modelFetch(
  authorize: () => Promise<void>,
  route: ModelRoute,
  send: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (endpointSchema.parse(url) !== endpointSchema.parse(route.endpoint))
      throw new PolicyError("modelEndpointMismatch", 403);
    if (typeof init?.body !== "string")
      throw new PolicyError("modelPayloadInvalid", 403);
    let payload: { model?: unknown };
    try {
      payload = JSON.parse(init.body);
    } catch {
      throw new PolicyError("modelPayloadInvalid", 403);
    }
    if (payload.model !== route.model)
      throw new PolicyError("modelAliasDenied", 403);
    init.signal?.throwIfAborted();
    await authorize();
    init.signal?.throwIfAborted();
    return send(input, { ...init, redirect: "error" });
  };
}
export const AGENT_ROUTE: ModelRoute = {
  provider: "opencode",
  model: "deepseek-v4.1-flash",
  endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
  region: "unknown",
};
export const coordinatorRoute = (model: string): ModelRoute => ({
  provider: "vercel_gateway",
  model,
  endpoint: "https://ai-gateway.vercel.sh/v4/ai/language-model",
  region: "unknown",
});
