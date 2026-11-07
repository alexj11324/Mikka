import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { auth } from "@/lib/api-auth";
import { readCapture } from "@/lib/captures/store";
import { factoryApprovals } from "@/lib/factory/server";
import { factoryBrowserSession } from "@/lib/factory/browser-human";
import { factoryEvidenceMedia } from "@/lib/factory/evidence-media";

export const dynamic = "force-dynamic";

/** `GET /api/factory/tasks/:taskId/evidence/:captureId`: a screenshot or recording the task's evidence names. */
export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string; captureId: string }> },
) {
  const session = await factoryBrowserSession(request, (headers) =>
    auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  );
  const actor = session ? { userId: session.user.id, sessionId: session.session.id } : null;
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const { taskId, captureId } = await context.params;
    // The downstream capture handler also rejects delegated authorization. Strip
    // it only after the real native/browser session above produced a human actor.
    const mediaHeaders = new Headers(request.headers);
    if (actor) mediaHeaders.delete('authorization');
    const mediaRequest = new Request(request, { headers: mediaHeaders });
    return factoryEvidenceMedia(mediaRequest, { actor, taskId, captureId }, {
      capture: (...args) => factoryApprovals.capture(...args),
      read: readCapture,
    });
  });

}
