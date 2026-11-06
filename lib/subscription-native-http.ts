import { z } from "zod";
import { SubscriptionRefusal } from "@mikka/protocol/subscription";
import { WorkerRefusal } from "../packages/daemon/src/subscription-worker-client";
import { isDeviceAuthorityError } from "./db/device-scope";
import { ModelAdmissionError } from "./model-admission/contract";
import type { SubscriptionService } from "./subscription-service";
import { subscriptionNativeTiming } from "./subscription-native-timing";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("context") }).strict(),
  z
    .object({
      action: z.literal("request"),
      payload: z
        .object({
          path: z.string().min(1).max(128),
          headers: z
            .record(z.string().max(128), z.string().max(4096))
            .refine((value) => Object.keys(value).length <= 32),
          body: z.unknown(),
        })
        .strict(),
    })
    .strict(),
]);
export function subscriptionNativeHTTP(deps: {
  authorize(request: Request, deviceId: string): Promise<string | null>;
  service(): SubscriptionService;
  /** Fixed refusal metadata only; never a provider response, URL, message or credential. */
  log?(line: string): void;
}) {
  return async (
    request: Request,
    context: { params: Promise<{ deviceId: string; runId: string }> },
  ): Promise<Response> => {
    const headers = { "cache-control": "private, no-store" };
    let identity: { deviceId: string; runId: string } | undefined;
    let operation: "context" | "request" | null = null;
    let phase = "input";
    let timing: ReturnType<typeof subscriptionNativeTiming> | undefined;
    let outcome: 'ok' | 'error' = 'ok';
    try {
      const { deviceId, runId } = await context.params;
      if (
        !z.uuid().safeParse(deviceId).success ||
        !z.uuid().safeParse(runId).success
      )
        return new Response(null, { status: 404, headers });
      identity = { deviceId, runId };
      timing = subscriptionNativeTiming('http', runId);
      phase = "authorize";
      const owner = await timing.measure('authorize', () => deps.authorize(request, deviceId));
      if (!owner) { outcome = 'error'; return new Response(null, { status: 401, headers }); }
      phase = "input";
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        outcome = 'error'; return new Response(null, { status: 415, headers });
      }
      const reader = request.body?.getReader();
      if (!reader) throw new Error("request refused");
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 393216) {
            await reader.cancel();
            throw new Error("request refused");
          }
          parts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const body = input.parse(JSON.parse(new TextDecoder().decode(bytes)));
      operation = body.action;
      phase = "runtime";
      const service = deps.service();
      phase = "binding";
      const use = await timing.measure('binding', () => service.nativeRun(owner, deviceId, runId));
      if (body.action === "context") {
        phase = "context";
        return Response.json(await timing.measure('context', () => service.nativeContext(use, request.signal)), {
          headers,
        });
      }
      phase = "request";
      const upstream = await timing.measure('request', () => service.nativeRequest(
        use,
        body.payload,
        request.signal,
      ));
      return new Response(upstream.body, {
        headers: { ...headers, "content-type": upstream.contentType },
      });
    } catch (error) {
      outcome = 'error';
      // Preserve the outer device route's revoked 401 / unavailable 503 fence.
      if (isDeviceAuthorityError(error)) throw error;
      const subscription = error instanceof SubscriptionRefusal;
      const worker = error instanceof WorkerRefusal;
      const model = error instanceof ModelAdmissionError;
      const code = subscription || worker ? error.code : model ? "model_policy_refused" : "subscription_unavailable";
      try {
        (deps.log ?? console.warn)(JSON.stringify({
          event: "subscription_native_refused", ...identity, operation, phase,
          code: typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "subscription_unavailable",
          errorClass: subscription ? "SubscriptionRefusal" : worker ? "WorkerRefusal" : model ? "ModelAdmissionError" : error instanceof z.ZodError ? "ZodError" : "unknown",
        }));
      } catch { /* A diagnostic failure cannot replace the refusal. */ }
      return Response.json(
        { error: "subscription_unavailable" },
        // A failed authority/database lookup is unavailable, not a revoked grant.
        // Keep explicit refusals and invalid input on their existing conflict path.
        { status: subscription || worker || model || phase === "input" ? 409 : 503, headers },
      );
    } finally {
      timing?.end(outcome);
    }
  };
}
