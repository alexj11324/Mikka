import { auth } from "@/lib/auth";
import { humanSessionHeaders } from "@/lib/desktop-rpc/handler";
import { writeAllowed } from "@/lib/mobile-api";
import { GitHubAccessError } from "@/lib/github/user-access";
import { mergePullRequest, pullMergeDependencies } from "@/lib/github/pull-merge";
import { pullMergeInput } from "@/lib/pull-directory";
import { withRequestLog } from "@/lib/request-log";

export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
const permission = new Set(["githubMergeAuthorizationRequired", "githubMergeForbidden"]);
/** Merges one pull request as the signed-in person (lib/github/pull-merge.ts). */
export const POST = withRequestLog(
  "/api/integrations/github/repositories/pulls/merge",
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
    if (!writeAllowed(request))
      return Response.json({ error: "originNotAllowed" }, { status: 403, headers });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // error-cause: a malformed body is the caller's input, answered as invalid input.
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    }
    const input = pullMergeInput.safeParse(body);
    if (!input.success)
      return Response.json({ error: "invalidInput" }, { status: 400, headers });
    try {
      const result = await mergePullRequest(
        session.user.id,
        input.data,
        pullMergeDependencies({ deadline: Date.now() + 55_000, signal: request.signal }),
      );
      const status =
        result.kind === "merged"
          ? 200
          : result.kind === "needs_confirm"
            ? 409
            : permission.has(result.code)
              ? 403
              : 409;
      return Response.json(result, { status, headers });
    } catch (error) {
      if (request.signal.aborted) throw error;
      // A merge whose answer was lost is re-read in mergePullRequest and returned as merged; what
      // reaches here did not merge this head. Logged by name and code only: provider messages can
      // carry private data.
      console.error("Pull request merge failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: error instanceof GitHubAccessError ? error.code : null,
      });
      const failure =
        error instanceof GitHubAccessError
          ? error
          : new GitHubAccessError("githubUnavailable", 502, { cause: error });
      return Response.json(
        { error: failure.code },
        { status: failure.status, headers },
      );
    }
  },
);
