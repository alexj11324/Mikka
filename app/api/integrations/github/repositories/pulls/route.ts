import { auth } from "@/lib/auth";
import { humanSessionHeaders } from "@/lib/desktop-rpc/handler";
import { GitHubAccessError } from "@/lib/github/user-access";
import { repositoryPullDirectory } from "@/lib/github/pull-directory";
import { pullPageInput } from "@/lib/pull-directory";
import { withRequestLog } from "@/lib/request-log";

const headers = { "Cache-Control": "private, no-store" };
export const GET = withRequestLog(
  "/api/integrations/github/repositories/pulls",
  async (request: Request) => {
    const sessionHeaders = humanSessionHeaders(request);
    const session =
      sessionHeaders &&
      (await auth.api.getSession({
        headers: sessionHeaders,
        query: { disableCookieCache: true },
      }));
    if (!session?.user)
      return Response.json({ error: "authRequired" }, { status: 401, headers });
    const params = new URL(request.url).searchParams;
    const allowed = new Set(["repo", "cursor", "view"]);
    if (
      [...params.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => params.getAll(key).length > 1)
    )
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    const input = pullPageInput.safeParse({
      repo: params.get("repo"),
      cursor: params.get("cursor"),
      view: params.get("view") ?? "open",
    });
    if (!input.success)
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    try {
      const page = await repositoryPullDirectory(session.user.id, input.data, {
        deadline: Date.now() + 25_000,
        signal: request.signal,
      });
      return Response.json({ ...page, viewerId: session.user.id }, { headers });
    } catch (error) {
      if (request.signal.aborted) throw error;
      const failure =
        error instanceof GitHubAccessError
          ? error
          : new GitHubAccessError("githubUnavailable", 502);
      return Response.json(
        { error: failure.code },
        { status: failure.status, headers },
      );
    }
  },
);
