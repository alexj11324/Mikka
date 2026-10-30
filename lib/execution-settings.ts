import "server-only";
import { enqueueDeviceCommand } from "./device-management";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_EXECUTION_RULE, type ExecutionRule } from "./execution-rules";
import { isDeviceOnline } from "@mikka/protocol/device";

export interface ExecutionSettingsScope {
  ownerId: string;
  workspaceId: string;
}
const ruleInput = z
  .object({
    label: z.string().trim().min(1).max(200),
    place: z.union([z.literal("auto"), z.literal("cloud"), z.uuid()]),
    harness: z.enum(["auto", "claude_code", "codex", "cursor"]),
    model: z.string().trim().min(1).max(128),
  })
  .strict();

/** Callers obtain scope from the session and current workspace, never from input. */
export class ExecutionSettings {
  constructor(readonly pool: Pool) {}
  async list(scope: ExecutionSettingsScope): Promise<ExecutionRule[]> {
    const { rows } = await this.pool.query(
      'SELECT id,label,place,harness,model,position FROM execution_rules WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
      [scope.ownerId, scope.workspaceId],
    );
    return [...rows, DEFAULT_EXECUTION_RULE];
  }
  async mutate(
    scope: ExecutionSettingsScope,
    operation:
      | { kind: "save"; id?: string; value: z.infer<typeof ruleInput> }
      | { kind: "delete"; id: string }
      | { kind: "reorder"; ids: string[] },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`execution-settings:${scope.ownerId}:${scope.workspaceId}`],
      );
      const rows = (
        await client.query(
          'SELECT id FROM execution_rules WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
          [scope.ownerId, scope.workspaceId],
        )
      ).rows;
      let ids: string[] = rows.map((r) => r.id);
      if (operation.kind === "reorder") {
        z.array(z.uuid()).parse(operation.ids);
        if (
          new Set(operation.ids).size !== ids.length ||
          operation.ids.length !== ids.length ||
          operation.ids.some((id) => !ids.includes(id))
        )
          throw new Error("validationGeneric");
        ids = operation.ids;
      } else if (operation.kind === "delete") {
        if (!ids.includes(operation.id)) throw new Error("validationGeneric");
        await client.query(
          'DELETE FROM execution_rules WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',
          [operation.id, scope.ownerId, scope.workspaceId],
        );
        ids = ids.filter((id) => id !== operation.id);
      } else {
        const value = ruleInput.parse(operation.value);
        if (!["auto", "cloud"].includes(value.place)) {
          const device = await client.query(
            `SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL`,
            [value.place, scope.ownerId],
          );
          if (!device.rowCount) throw new Error("agentNoDevice");
        }
        const id = operation.id ?? randomUUID();
        if (operation.id) {
          if (!ids.includes(id)) throw new Error("validationGeneric");
          await client.query(
            'UPDATE execution_rules SET label=$4,place=$5,harness=$6,model=$7 WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',
            [
              id,
              scope.ownerId,
              scope.workspaceId,
              value.label,
              value.place,
              value.harness,
              value.model,
            ],
          );
        } else {
          await client.query(
            'INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              id,
              scope.ownerId,
              scope.workspaceId,
              value.label,
              value.place,
              value.harness,
              value.model,
              ids.length,
            ],
          );
          ids.push(id);
        }
      }
      for (const [position, id] of ids.entries())
        await client.query(
          'UPDATE execution_rules SET position=$4 WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',
          [id, scope.ownerId, scope.workspaceId, position],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.list(scope);
  }
  async places(scope: ExecutionSettingsScope) {
    const { rows } = await this.pool.query(
      `SELECT id,name,"deviceType",enabled,"lastSeenAt",harnesses FROM devices WHERE "ownerId"=$1 AND kind='local' AND "removedAt" IS NULL ORDER BY "createdAt",id`,
      [scope.ownerId],
    );
    return [
      ...rows.map((row) => ({
        ...row,
        online: isDeviceOnline(row.lastSeenAt),
      })),
      {
        id: "cloud",
        kind: "cloud",
        deviceType: "server",
        online: true,
        harnesses: [],
      },
    ];
  }
  async redetect(scope: ExecutionSettingsScope, deviceId: string) {
    z.uuid().parse(deviceId);
    const id = await enqueueDeviceCommand(
      scope.ownerId,
      deviceId,
      "redetect",
      this.pool,
    );
    if (!id) throw new Error("agentNoDevice");
    return { commandId: id };
  }
  /** Only connected account bindings; no static or environment model catalogue. */
  async botModels(scope: ExecutionSettingsScope) {
    return (
      await this.pool.query(
        `SELECT b.id AS "bindingId",b."consumerId",b."modelId",b.route,c.id AS "connectionId",c.provider FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c."workspaceId"=b."workspaceId" AND c.epoch=b."connectionRevision" AND c.state='connected' WHERE b."ownerId"=$1 AND b."workspaceId"=$2 AND b.route IN ('codex_cpa','claude_cpa','openai_siwc') ORDER BY b."createdAt" DESC,b.id`,
        [scope.ownerId, scope.workspaceId],
      )
    ).rows;
  }
  async setBotModel(
    scope: ExecutionSettingsScope,
    botId: string | null,
    bindingId: string | null,
  ) {
    if (botId) {
      z.uuid().parse(botId);
      if (
        !(
          await this.pool.query(
            'SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',
            [botId, scope.ownerId, scope.workspaceId],
          )
        ).rowCount
      )
        throw new Error("validationGeneric");
    }
    const key = botId ?? "coordinator";
    if (!bindingId) {
      await this.pool.query(
        'DELETE FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [scope.ownerId, scope.workspaceId, key],
      );
      return;
    }
    z.uuid().parse(bindingId);
    const choice = (await this.botModels(scope)).find(
      (row) => row.bindingId === bindingId,
    );
    if (!choice) throw new Error("validationGeneric");
    bindingId = await this.bindingForBot(scope, botId, bindingId);
    await this.pool.query(
      'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId"',
      [scope.ownerId, scope.workspaceId, key, bindingId],
    );
  }
  /** Clone only the owner's connected account reference, never a credential. */
  async bindingForBot(
    scope: ExecutionSettingsScope,
    botId: string | null,
    bindingId: string,
  ): Promise<string> {
    if (!botId) return bindingId;
    const source = (await this.botModels(scope)).find(
      (row) => row.bindingId === bindingId,
    );
    if (!source) throw new Error("validationGeneric");
    if (source.consumerId === botId) return bindingId;
    const hash = createHash("sha256")
      .update(
        JSON.stringify([scope.ownerId, scope.workspaceId, botId, bindingId]),
      )
      .digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const result = await this.pool.query(
      `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      SELECT $1,b."ownerId",b."workspaceId",$2::text,b."connectionId",b."connectionRevision",b.route,b."modelId" FROM byos_bindings b
      JOIN bots bot ON bot.id=$2::uuid AND bot."ownerId"=$3 AND bot."workspaceId"=$4::uuid
      JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c."workspaceId"=b."workspaceId" AND c.epoch=b."connectionRevision" AND c.state='connected'
      WHERE b.id=$5 AND b."ownerId"=$3 AND b."workspaceId"=$4::text ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id`,
      [id, botId, scope.ownerId, scope.workspaceId, bindingId],
    );
    if (!result.rows[0]) throw new Error("validationGeneric");
    return result.rows[0].id;
  }
  async botModel(scope: ExecutionSettingsScope, botId: string | null) {
    return (
      await this.pool.query(
        'SELECT "bindingId" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [scope.ownerId, scope.workspaceId, botId ?? "coordinator"],
      )
    ).rows[0]?.bindingId as string | undefined;
  }
}

/** Bot scope is exact. Coordinator uses the owner's first active workspace,
 * matching the settings fallback in a workflow without browser cookies. */
export async function executionWorkspace(
  ownerId: string,
  botId: string | null,
): Promise<string> {
  const { pool } = await import("./db");
  if (botId) {
    const bot = (
      await pool.query(
        'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',
        [botId, ownerId],
      )
    ).rows[0];
    if (!bot) throw new Error("validationGeneric");
    await (
      await import("./subscription-runtime")
    ).authorizeSubscriptionWorkspace(ownerId, bot.workspaceId);
    return bot.workspaceId;
  }
  const { workspaceDb } = await import("./workspace-db");
  const { workspaceMembers, workspaces } =
    await import("./db/workspace-schema");
  const { and, eq, asc } = await import("drizzle-orm");
  const [workspace] = await workspaceDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id),
    )
    .where(
      and(
        eq(workspaceMembers.userId, ownerId),
        eq(workspaceMembers.status, "active"),
      ),
    )
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  if (!workspace) throw new Error("validationGeneric");
  return workspace.id;
}
