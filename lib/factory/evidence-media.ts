import type { CaptureView } from "@mikka/protocol/capture";
import { captureFileResponse } from "@/lib/captures/serve";
import type { FactoryHuman } from "./approval-contract";

type CaptureFile = CaptureView & { bytes: Uint8Array<ArrayBuffer> };

export interface EvidenceMediaDeps {
  /** The acceptance read: the task's evidence must name this capture. */
  capture: (actor: FactoryHuman, taskId: string, captureId: string) => Promise<{ ownerId: string }>;
  /** The captures store's owner-scoped read. */
  read: (userId: string, captureId: string) => Promise<CaptureFile | null>;
}

const NOT_FOUND = new Set(["factoryNotFound", "factoryArtifactMissing", "factoryInvalid"]);

/**
 * A screenshot or recording that is evidence of a Factory task, served by the
 * captures serve path. Both checks apply: the person may review the task
 * (`capture`) and owns the capture (`read`).
 */
export async function factoryEvidenceMedia(
  request: Request,
  input: { actor: FactoryHuman | null; taskId: string; captureId: string },
  deps: EvidenceMediaDeps,
): Promise<Response> {
  const headers = { "cache-control": "private, no-store" };
  if (!input.actor || request.headers.get("authorization"))
    return new Response(null, { status: 401, headers });
  let bound: { ownerId: string };
  try {
    bound = await deps.capture(input.actor, input.taskId, input.captureId);
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
    if (!code?.startsWith("factory")) throw error;
    return new Response(null, { status: NOT_FOUND.has(code) ? 404 : code === "factoryHumanRequired" ? 401 : 409, headers });
  }
  // Never wider than the captures route: only the owner's own capture.
  if (bound.ownerId !== input.actor.userId) return new Response(null, { status: 404, headers });
  const file = await deps.read(input.actor.userId, input.captureId);
  if (!file) return new Response(null, { status: 404, headers });
  return captureFileResponse(request, file, headers);
}
