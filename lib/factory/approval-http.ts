import { z } from "zod";
import type { FactoryHuman } from "./approval-contract";
import type { createFactoryApprovals } from "./approval";
import { PublicationDeferred } from "./publication-operation";

export interface ApprovalHttpRequest {
  actor: FactoryHuman | null;
  authorization: string | null;
  method: string;
  taskId: string;
  origin: string | null;
  url: string;
  body?: unknown;
}

/** Browser cookies only. This handler is never registered as an MCP/daemon tool. */
export async function handleFactoryApproval(
  service: ReturnType<typeof createFactoryApprovals>,
  req: ApprovalHttpRequest,
) {
  if (!req.actor || req.authorization)
    return { status: 401, body: { error: "factoryHumanRequired" } };
  if (!z.uuid().safeParse(req.taskId).success)
    return { status: 404, body: { error: "factoryNotFound" } };
  if (!["GET", "POST"].includes(req.method))
    return { status: 405, body: { error: "methodNotAllowed" } };
  if (req.method === "POST") {
    try {
      if (new URL(req.origin ?? "").origin !== new URL(req.url).origin)
        throw new Error("origin");
    } catch {
      return { status: 403, body: { error: "originRejected" } };
    }
  }
  try {
    if (req.method === "GET") {
      if (new URL(req.url).searchParams.get("view") === "ledger")
        return {
          status: 200,
          body: await service.ledger(req.actor, req.taskId),
        };
      const artifact = new URL(req.url).searchParams.get("artifact");
      return {
        status: 200,
        body: artifact
          ? await service.artifact(req.actor, req.taskId, artifact)
          : await service.evidence(req.actor, req.taskId),
      };
    }
    const parsed = z
      .object({
        operation: z.enum(["approve", "reject", "revoke", "publish", "reconcile"]),
        input: z
          .object({ binding: z.object({ taskId: z.uuid() }).passthrough() })
          .passthrough(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success || parsed.data.input.binding.taskId !== req.taskId)
      return { status: 422, body: { error: "factoryInvalid" } };
    const { operation, input } = parsed.data;
    return { status: 200, body: await service[operation](req.actor, input) };
  } catch (error) {
    if (error instanceof PublicationDeferred)
      return {
        status: error.state === "pending" ? 202 : 409,
        body: {
          error: error.code,
          publicationId: error.publicationId,
          status: error.state,
          nextOperation: "reconcile",
        },
      };
    // #192's store may throw its own Error class; consume its public error code,
    // not an instanceof identity tied to a second copy of the stage module.
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !error.code.startsWith("factory")
    )
      throw error;
    return {
      status:
        error.code === "factoryNotFound"
          ? 404
          : error.code === "factoryHumanRequired"
            ? 401
            : error.code === "factoryInvalid"
              ? 422
              : 409,
      body: { error: error.code },
    };
  }
}
