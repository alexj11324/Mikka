import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import {
  appendAudit,
  AuditError,
  createExport,
  digest,
  exportPage,
  head,
  pruneAudit,
  transaction,
  verifyAudit,
} from "./store";

type Actor = { userId: string };
const sequence = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const uuid = z.uuid();
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
async function smallBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new AuditError("auditInvalid", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AuditError("auditInvalid", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new AuditError("auditInvalid", 413);
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
export function auditHttp(deps: {
  app: Pool;
  workspace: Pool;
  origin?: string;
  authenticate: (req: Request) => Promise<Actor | null>;
}) {
  return async (request: Request, exporting = false): Promise<Response> => {
    let deniedWorkspace: string | undefined;
    try {
      if (
        request.headers.has("authorization") ||
        !request.headers.get("cookie")
      )
        throw new AuditError("auditBrowserRequired", 401);
      const actor = await deps.authenticate(request);
      if (!actor) throw new AuditError("auditBrowserRequired", 401);
      const url = new URL(request.url);
      const workspace = url.searchParams.get("workspaceId");
      if (workspace !== null && !uuid.safeParse(workspace).success)
        throw new AuditError("auditInvalid", 422);
      const tenant = workspace ?? `personal:${actor.userId}`;
      if (!["GET", "POST"].includes(request.method))
        throw new AuditError("methodNotAllowed", 405);
      if (
        request.method === "POST" &&
        request.headers.get("origin") !== (deps.origin ?? url.origin)
      )
        throw new AuditError("originRejected", 403);
      const work = async (ws: PoolClient) => {
        if (workspace) {
          const member = (
            await ws.query(
              `SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,
              [workspace, actor.userId],
            )
          ).rows[0];
          if (member?.role === "member") deniedWorkspace = workspace;
          if (member?.role !== "admin")
            throw new AuditError("auditAccessDenied", 403);
        }
        const source = z
          .enum(["application", "workspace"])
          .parse(url.searchParams.get("source") ?? "application");
        const run = <T>(operation: (tx: PoolClient) => Promise<T>) =>
          source === "workspace"
            ? operation(ws)
            : transaction(deps.app, operation);
        if (exporting && request.method === "POST") {
          const id = uuid.parse(request.headers.get("idempotency-key"));
          // Each database gets an explicit independent snapshot; retry resumes partial creation.
          const application = await transaction(deps.app, (tx) =>
            createExport(tx, tenant, actor.userId, id),
          );
          const workspaceSnapshot = await createExport(
            ws,
            tenant,
            actor.userId,
            id,
          );
          return Response.json(
            {
              id,
              format: "mikka-audit-jsonl-v1",
              snapshots: { application, workspace: workspaceSnapshot },
            },
            { headers },
          );
        }
        if (exporting) {
          const id = uuid.parse(url.searchParams.get("id"));
          const after = sequence.parse(url.searchParams.get("after") ?? "0");
          const limit = z.coerce
            .number()
            .int()
            .min(1)
            .max(1000)
            .parse(url.searchParams.get("limit") ?? "200");
          const page = await run((tx) =>
            exportPage(tx, tenant, actor.userId, id, after, limit),
          );
          const lines = page.rows
            .map((row) => JSON.stringify({ type: "event", source, ...row }))
            .join("\n");
          const body =
            JSON.stringify({
              type: "manifest",
              version: 1,
              source,
              ...page.snapshot,
              pageCount: page.rows.length,
              pageDigest: digest(lines),
              next: page.next,
            }) +
            "\n" +
            (lines ? lines + "\n" : "");
          return new Response(body, {
            headers: {
              ...headers,
              "Content-Type": "application/x-ndjson",
              "Content-Disposition": `attachment; filename="audit-${source}-${id}.jsonl"`,
            },
          });
        }
        if (request.method === "POST") {
          const body = z
            .discriminatedUnion("operation", [
              z
                .object({
                  operation: z.literal("policy"),
                  retentionDays: z.number().int().min(1).max(3650),
                  legalHold: z.boolean(),
                })
                .strict(),
              z.object({ operation: z.literal("prune") }).strict(),
              z.object({ operation: z.literal("verify") }).strict(),
            ])
            .parse(await smallBody(request));
          const result = await run(async (tx) => {
            if (body.operation === "verify") {
              const h = await verifyAudit(tx, tenant);
              return {
                integrity: "verified",
                seq: h.seq,
                hash: h.hash,
                floor: h.floor,
                floorHash: h.floor_hash,
              };
            }
            if (body.operation === "prune")
              return pruneAudit(tx, tenant, actor.userId);
            await head(tx, tenant);
            await tx.query(
              "UPDATE security_audit_heads SET retention_days=$2,legal_hold=$3 WHERE tenant=$1",
              [tenant, body.retentionDays, body.legalHold],
            );
            await appendAudit(tx, tenant, {
              actorId: actor.userId,
              actorType: "human",
              resourceId: tenant,
              action: "audit.policy",
              outcome: "success",
              reason: `days_${body.retentionDays}.hold_${body.legalHold}`,
            });
            return {
              retentionDays: body.retentionDays,
              legalHold: body.legalHold,
            };
          });
          return Response.json(result, { headers });
        }
        const after = sequence.parse(url.searchParams.get("after") ?? "0");
        const action = z
          .string()
          .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
          .nullable()
          .parse(url.searchParams.get("action"));
        const outcome = z
          .enum(["success", "denied", "failed", "uncertain", "pending"])
          .nullable()
          .parse(url.searchParams.get("outcome"));
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(1000)
          .parse(url.searchParams.get("limit") ?? "200");
        return Response.json(
          await run(async (tx) => {
            const h = await head(tx, tenant);
            if (BigInt(after) < BigInt(h.floor))
              throw new AuditError("auditCursorExpired", 410);
            const { rows } = await tx.query(
              "SELECT seq,id,occurred_at,event,prev_hash,hash FROM security_audit_events WHERE tenant=$1 AND seq>$2 AND ($4::text IS NULL OR event->>'action'=$4) AND ($5::text IS NULL OR event->>'outcome'=$5) ORDER BY seq LIMIT $3",
              [tenant, after, limit, action, outcome],
            );
            return {
              source,
              events: rows,
              next: rows.at(-1)?.seq ?? null,
              head: h,
            };
          }),
          { headers },
        );
      };
      try {
        return await transaction(deps.workspace, work);
      } catch (error) {
        if (error instanceof AuditError && error.code === "auditAccessDenied") {
          // A known member refusal is tenant-scoped; unknown targets stay personal.
          await appendAudit(
            deniedWorkspace ? deps.workspace : deps.app,
            deniedWorkspace ?? `personal:${actor.userId}`,
            {
              actorId: actor.userId,
              actorType: "human",
              resourceId: "audit",
              action: "authorization.denied",
              outcome: "denied",
              reason: "audit_admin_required",
              requestId: randomUUID(),
            },
          );
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof AuditError && error.status === 401) {
        try {
          await appendAudit(deps.app, "system:auth", {
            actorId: "anonymous",
            actorType: "anonymous",
            resourceId: "audit",
            action: "authorization.denied",
            outcome: "denied",
            reason: "audit_browser_required",
            requestId: randomUUID(),
          });
        } catch {
          return Response.json(
            { error: "auditUnavailable" },
            { status: 503, headers },
          );
        }
      }
      if (error instanceof AuditError)
        return Response.json(
          { error: error.code },
          { status: error.status, headers },
        );
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json(
          { error: "auditInvalid" },
          { status: 422, headers },
        );
      // Do not return PostgreSQL details or any event body on persistence failure.
      return Response.json(
        { error: "auditUnavailable" },
        { status: 503, headers },
      );
    }
  };
}
