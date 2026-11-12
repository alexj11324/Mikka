import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { NextResponse } from "next/server";
import { auth } from "@/lib/api-auth";
import { factoryApprovals, factoryMerges } from "@/lib/factory/server";
import { GitHubAccessError, githubUserToken } from "@/lib/github/user-access";
import { handleFactoryApproval } from "@/lib/factory/approval-http";
import { FactoryMergeRefused } from "@/lib/factory/merge";
import { factoryBrowserSession } from "@/lib/factory/browser-human";

export const dynamic = "force-dynamic";
async function respond(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  // Do not permit delegated OAuth/worker credentials to acquire a human actor.
  const authorization = request.headers.get("authorization");
  const session = await factoryBrowserSession(request, (headers) =>
    auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  );
  const expectedOwner = request.headers.get('x-mikka-expected-owner');
  if (expectedOwner && expectedOwner !== session?.user.id) return NextResponse.json({ error: 'authRequired' }, { status: 401 });
  const actor = session ? { userId: session.user.id, sessionId: session.session.id } : null;
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const { taskId } = await context.params;
    const result = await handleFactoryApproval(factoryApprovals, {
      actor,
      // A real native session was checked above; delegated tokens never yield actor.
      authorization: actor ? null : authorization,
      method: request.method,
      taskId,
      origin: request.headers.get("origin"),
      url: request.url,
      body:
        request.method === "POST"
          ? await request.json().catch(() => null)
          : undefined,
      // Acceptance merges as this person, with their own GitHub user token; never an app token.
      githubToken: async () => {
        try {
          return (await githubUserToken(request.headers)).token;
        } catch (error) {
          if (error instanceof GitHubAccessError && error.code === "githubUnavailable")
            throw new FactoryMergeRefused("githubUnavailable", null);
          if (error instanceof GitHubAccessError) return null;
          throw error;
        }
      },
    }, factoryMerges);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  });

}
export const GET = respond;
export const POST = respond;
