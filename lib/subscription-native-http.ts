import { z } from "zod";
import type { SubscriptionService } from "./subscription-service";
import { pool } from './db'
import { nativeSessionSnapshot } from './ci-native-session-store'

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("context") }).strict(),
  z.object({ action: z.literal('save_session'), sessionId: z.string().min(1).max(500), data: z.string().min(1).max(2_800_000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  z.object({ action: z.literal('restore_session') }).strict(),
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
}) {
  return async (
    request: Request,
    context: { params: Promise<{ deviceId: string; runId: string }> },
  ): Promise<Response> => {
    const headers = { "cache-control": "private, no-store" };
    try {
      const { deviceId, runId } = await context.params;
      if (
        !z.uuid().safeParse(deviceId).success ||
        !z.uuid().safeParse(runId).success
      )
        return new Response(null, { status: 404, headers });
      const owner = await deps.authorize(request, deviceId);
      if (!owner) return new Response(null, { status: 401, headers });
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return new Response(null, { status: 415, headers });
      const reader = request.body?.getReader();
      if (!reader) throw new Error("request refused");
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2_801_024) {
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
      const service = deps.service();
      const use = await service.nativeRun(owner, deviceId, runId);
      if (body.action === "context")
        return Response.json(await service.nativeContext(use, request.signal), {
          headers,
        });
      if (body.action === 'save_session' || body.action === 'restore_session') {
        const current = await service.nativeContext(use, request.signal)
        const operation = body.action === 'save_session'
          ? { kind: 'save' as const, sessionId: body.sessionId, data: Buffer.from(body.data, 'base64') }
          : { kind: 'restore' as const }
        if (body.action === 'save_session' && operation.kind === 'save' && operation.data.toString('base64') !== body.data) throw new Error('request refused')
        const data = await nativeSessionSnapshot(pool, { ownerId: owner, deviceId, runId, accountId: current.accountId, revision: current.revision, route: current.route, modelId: current.modelId }, operation, process.env.BETTER_AUTH_SECRET ?? '')
        return Response.json({ data: data?.toString('base64') ?? null }, { headers })
      }
      const upstream = await service.nativeRequest(
        use,
        body.payload,
        request.signal,
      );
      return new Response(upstream.body, {
        headers: { ...headers, "content-type": upstream.contentType },
      });
    } catch {
      return Response.json(
        { error: "subscription_unavailable" },
        { status: 409, headers },
      );
    }
  };
}
