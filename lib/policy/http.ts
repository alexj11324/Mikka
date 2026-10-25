import { z } from "zod";
import { PolicyStore } from "./store";
import { documentSchema, PolicyError } from "./contract";
const publishSchema = z.union([
  z.strictObject({
    expectedVersion: z.number().int().min(0).max(2147483646),
    document: documentSchema,
  }),
  z.strictObject({
    expectedVersion: z.number().int().min(1).max(2147483646),
    rollbackOf: z.number().int().positive(),
  }),
]);
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new PolicyError("policyInvalid", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new PolicyError("policyInvalid", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new PolicyError("policyInvalid", 413);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new PolicyError("policyInvalid", 422);
    }
  } finally {
    reader.releaseLock();
  }
}
export function policyHttp(deps: {
  store: PolicyStore;
  origin: string;
  authenticate(request: Request): Promise<{ userId: string } | null>;
}) {
  return async (request: Request) => {
    try {
      if (
        request.headers.has("authorization") ||
        !request.headers.get("cookie")
      )
        throw new PolicyError("policyBrowserRequired", 401);
      const actor = await deps.authenticate(request);
      if (!actor) throw new PolicyError("policyBrowserRequired", 401);
      const url = new URL(request.url);
      const workspaceId = z.uuid().parse(url.searchParams.get("workspaceId"));
      if (request.method === "GET") {
        const version = url.searchParams.has("version")
          ? z.coerce
              .number()
              .int()
              .positive()
              .parse(url.searchParams.get("version"))
          : undefined;
        const signed = await deps.store.read(
          workspaceId,
          actor.userId,
          version,
        );
        // Current effective binding carries its own signed version. No mixed-version response.
        let effective;
        let blocked;
        if (signed && version === undefined) {
          try {
            effective = await deps.store.current(actor.userId, workspaceId);
          } catch (error) {
            if (
              !(error instanceof PolicyError) ||
              error.code !== "policyRevoked"
            )
              throw error;
            blocked = error.code;
          }
        }
        return Response.json(
          {
            signed: effective?.[0]?.signed ?? signed,
            effective,
            blocked,
            keyId: deps.store.signer.keyId,
            publicKey: deps.store.signer.publicKey,
          },
          { headers },
        );
      }
      if (request.method !== "POST")
        throw new PolicyError("methodNotAllowed", 405);
      if (
        !deps.origin ||
        request.headers.get("origin") !== deps.origin ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new PolicyError("originRejected", 403);
      const input = publishSchema.parse(await body(request));
      const result =
        "document" in input
          ? await deps.store.publish(
              workspaceId,
              actor.userId,
              input.expectedVersion,
              input.document,
            )
          : await deps.store.publish(
              workspaceId,
              actor.userId,
              input.expectedVersion,
              undefined,
              input.rollbackOf,
            );
      return Response.json(result, { status: 201, headers });
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      return Response.json(
        {
          error:
            error instanceof PolicyError
              ? error.code
              : invalid
                ? "policyInvalid"
                : "policyUnavailable",
        },
        {
          status:
            error instanceof PolicyError ? error.status : invalid ? 422 : 503,
          headers,
        },
      );
    }
  };
}
