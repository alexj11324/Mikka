import { auth } from "@/lib/auth";
import { readCapture } from "@/lib/captures/store";
import { factoryApprovals } from "@/lib/factory/server";
import { factoryBrowserHuman } from "@/lib/factory/browser-human";
import { factoryEvidenceMedia } from "@/lib/factory/evidence-media";

export const dynamic = "force-dynamic";

/** `GET /api/factory/tasks/:taskId/evidence/:captureId`: a screenshot or recording the task's evidence names. */
export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string; captureId: string }> },
) {
  const actor = await factoryBrowserHuman(request, (headers) =>
    auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  );
  const { taskId, captureId } = await context.params;
  return factoryEvidenceMedia(request, { actor, taskId, captureId }, {
    capture: (...args) => factoryApprovals.capture(...args),
    read: readCapture,
  });
}
