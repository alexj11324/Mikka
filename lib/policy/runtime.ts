import "server-only";
import { auth } from "@/lib/auth";
import { workspacePool } from "@/lib/workspace-db";
import { appOrigin } from "@/lib/mcp/resource";
import { policySigner } from "./signing";
import { PolicyStore } from "./store";
import { policyHttp } from "./http";
import { authorizeModelRequest } from "./model";
import { PolicyError, type ModelRoute } from "./contract";

export function policyStore() {
  return new PolicyStore(
    workspacePool,
    policySigner(process.env.BETTER_AUTH_SECRET ?? ""),
  );
}
export async function handlePolicy(request: Request) {
  try {
    return await policyHttp({
      store: policyStore(),
      origin: appOrigin ?? "",
      authenticate: async (req) => {
        const session = await auth.api.getSession({
          headers: req.headers,
          query: { disableCookieCache: true },
        });
        return session ? { userId: session.user.id } : null;
      },
    })(request);
  } catch {
    return Response.json(
      { error: "policyUnavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
export async function authorizeModel(userId: string, route: ModelRoute) {
  return authorizeModelRequest(policyStore(), userId, route);
}
export async function authorizePolicyWorker(
  userId: string,
  runId: string,
  issueId?: string,
  workspaceId?: string,
) {
  return policyStore().denyWorker(userId, runId, issueId, workspaceId);
}
/** Existing tool/native transports cannot attest to all model/network child calls. */
export async function authorizePolicyTool(
  userId: string,
  workspaceId?: string,
) {
  if ((await policyStore().current(userId, workspaceId)).length)
    throw new PolicyError("toolEnforcementUnavailable", 409);
}
