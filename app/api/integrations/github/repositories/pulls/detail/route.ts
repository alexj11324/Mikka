import { auth } from "@/lib/auth";
import { humanSessionHeaders } from "@/lib/desktop-rpc/handler";
import { GitHubAccessError } from "@/lib/github/user-access";
import { readPullDetail } from "@/lib/github/pull-detail";
import { pullDetailQuery } from "@/lib/pull-directory";
import { withRequestLog } from "@/lib/request-log";

const headers = { "Cache-Control": "private, no-store" };
/** One pull request's own page: summary, checks and reviews, for PRs with or without a linked task. */
export const GET = withRequestLog(
  "/api/integrations/github/repositories/pulls/detail",
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
    const allowed = new Set(["repo", "number"]);
    if (
      [...params.keys()].some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => params.getAll(key).length > 1)
    )
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    const input = pullDetailQuery.safeParse({
      repo: params.get("repo"),
      number: params.get("number"),
    });
    if (!input.success)
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    try {
      const detail = await readPullDetail(
        session.user.id,
        input.data.repo,
        Number(input.data.number),
        { deadline: Date.now() + 25_000, signal: request.signal },
      );
      return Response.json(
        { ...detail, viewerId: session.user.id },
        { headers },
      );
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
