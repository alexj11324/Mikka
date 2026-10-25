import "server-only";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { workspacePool } from "@/lib/workspace-db";
import { auditHttp } from "./http";
export const handleAudit = auditHttp({
  app: pool,
  workspace: workspacePool,
  authenticate: async (request) => {
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    return session ? { userId: session.user.id } : null;
  },
});
