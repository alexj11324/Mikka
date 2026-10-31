import "server-only";
import { ActionFailureError } from "./action-error";
import { readIssueMetadata } from "./issue-metadata";
import type { JSONContent } from "@tiptap/core";
import { enqueueDeviceCommand } from "./device-management";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { subscriptionsUsable } from "./personal-policy";
import {
  DEFAULT_EXECUTION_FALLBACKS,
  type ExecutionFallbacks,
  type ExecutionRule,
} from "./execution-rules";
import { isDeviceOnline } from "@mikka/protocol/device";

export interface ExecutionSettingsScope {
  ownerId: string;
  workspaceId: string;
}
const ruleInput = z
  .object({
    label: z.string().trim().min(1).max(200).nullable().optional(),
    place: z.union([z.literal("cloud"), z.uuid()]),
    harness: z.enum(["claude_code", "codex", "cursor"]),
    model: z.string().trim().min(1).max(128),
  })
  .strict();

/** Callers obtain scope from the session and current workspace, never from input. */
export class ExecutionSettings {
  constructor(readonly pool: Pool) {}
  async fallbacks(ownerId: string): Promise<ExecutionFallbacks> {
    return (
      (
        await this.pool.query(
          'SELECT "executionFallbacks" FROM "user" WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.executionFallbacks ?? DEFAULT_EXECUTION_FALLBACKS
    );
  }
  async setFallbacks(ownerId: string, value: ExecutionFallbacks) {
    const parsed = z
      .object({
        whenDeviceOffline: z.enum(["wait", "cloud"]),
        whenQuotaExhausted: z.enum(["stop", "switchAccount"]),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new ActionFailureError("validationGeneric");
    await this.pool.query(
      'UPDATE "user" SET "executionFallbacks"=$2::jsonb WHERE id=$1',
      [ownerId, JSON.stringify(parsed.data)],
    );
    return parsed.data;
  }
  /** A suggestion must come from a real installed harness or connected binding. */
  async suggested(
    scope: ExecutionSettingsScope,
    query: Pick<PoolClient, "query"> = this.pool,
  ): Promise<ExecutionRule> {
    const places = await this.places(scope, query);
    const models = await this.botModels(scope, query);
    const providers = (await subscriptionsUsable(query, scope.ownerId, scope.workspaceId))
      ? (await query.query(`SELECT provider FROM byos_connections WHERE "ownerId"=$1 AND state='connected'`,[scope.ownerId])).rows
      : [];
    const preferred = providers.some((m) => m.provider === "claude")
      ? "claude_code"
      : providers.some((m) => m.provider === "codex")
        ? "codex"
        : undefined;
    const devices = places
      .filter((p) => p.id !== "cloud" && p.enabled && p.online)
      .sort(
        (a, b) =>
          Number(b.deviceType === "server") - Number(a.deviceType === "server"),
      );
    for (const device of devices) {
      const harness = device.harnesses.find(
        (h: import("@mikka/protocol/harness").HarnessInfo) =>
          h.installed &&
          (!preferred || h.harness === preferred) &&
          (h.harness === "claude_code"
            ? h.modelSlots?.some((s) => s.slot === "opus")
            : h.harness === "codex"
              ? h.defaultModelSlot
              : h.models?.length),
      );
      if (harness)
        return {
          id: "default",
          label: null,
          place: device.id,
          harness: harness.harness,
          model:
            harness.harness === "claude_code"
              ? (harness.modelSlots?.find(
                  (s: { slot: string }) => s.slot === "opus",
                )?.slot ??
                harness.defaultModelSlot ??
                harness.models![0])
              : (harness.defaultModelSlot ?? harness.models![0]),
          position: 2147483647,
        };
    }
    const model = models.find(
      (m) =>
        !preferred ||
        m.provider === (preferred === "claude_code" ? "claude" : "codex"),
    );
    if (!model) throw new ActionFailureError("executionModelUnknown");
    return {
      id: "default",
      label: null,
      place: "cloud",
      harness: model.provider === "claude" ? "claude_code" : "codex",
      model: model.modelId,
      position: 2147483647,
    };
  }
  async list(scope: ExecutionSettingsScope): Promise<ExecutionRule[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`execution-settings:${scope.ownerId}:${scope.workspaceId}`],
      );
      let rows: ExecutionRule[] = (
        await client.query(
          'SELECT id,label,place,harness,model,position FROM execution_rules WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
          [scope.ownerId, scope.workspaceId],
        )
      ).rows;
      if (
        !rows.some((r) => r.label === null) ||
        rows.some((r) => [r.place, r.harness, r.model].includes("auto"))
      ) {
        const suggestion = await this.suggested(scope, client);
        for (const row of rows.filter((r) =>
          [r.place, r.harness, r.model].includes("auto"),
        )) {
          const places = await this.places(scope, client);
          const chosen =
            row.place === "auto"
              ? places
                  .filter((p) => p.id !== "cloud" && p.enabled && p.online)
                  .sort(
                    (a, b) =>
                      Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
                  )
                  .find((p) =>
                    p.harnesses.some(
                      (h: { installed: boolean; harness: string }) =>
                        h.installed &&
                        (row.harness === "auto" || h.harness === row.harness),
                    ),
                  )
              : places.find((p) => p.id === row.place);
          const place =
            row.place === "auto" ? (chosen?.id ?? "cloud") : row.place;
          const device = chosen;
          const harness =
            row.harness === "auto"
              ? (device?.harnesses.find(
                  (h: { installed: boolean }) => h.installed,
                )?.harness ?? suggestion.harness)
              : row.harness;
          const info = device?.harnesses.find(
            (h: { harness: string }) => h.harness === harness,
          );
          const model =
            row.model === "auto"
              ? (info?.defaultModelSlot ??
                info?.models?.[0] ??
                (await this.botModels(scope, client)).find(
                  (m) =>
                    m.provider ===
                    (harness === "claude_code" ? "claude" : "codex"),
                )?.modelId)
              : row.model;
          if (!model) throw new ActionFailureError("executionModelUnknown");
          await client.query(
            "UPDATE execution_rules SET place=$2,harness=$3,model=$4 WHERE id=$1",
            [row.id, place, harness, model],
          );
        }
        if (!rows.some((r) => r.label === null))
          await client.query(
            'INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,$4,$5,$6,2147483647)',
            [
              randomUUID(),
              scope.ownerId,
              scope.workspaceId,
              suggestion.place,
              suggestion.harness,
              suggestion.model,
            ],
          );
        rows = (
          await client.query(
            'SELECT id,label,place,harness,model,position FROM execution_rules WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
            [scope.ownerId, scope.workspaceId],
          )
        ).rows;
      }
      await client.query("COMMIT");
      return rows.map((r) => (r.label === null ? { ...r, id: "default" } : r));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async mutate(
    scope: ExecutionSettingsScope,
    operation:
      | { kind: "save"; id?: string; value: z.infer<typeof ruleInput> }
      | { kind: "delete"; id: string }
      | { kind: "reorder"; ids: string[] },
  ) {
    if (
      operation.kind === "save" &&
      [
        operation.value?.place,
        operation.value?.harness,
        operation.value?.model,
      ].some(value=>typeof value === "string" && value.trim() === "auto")
    )
      throw new ActionFailureError("executionAutoNotAllowed");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`execution-settings:${scope.ownerId}:${scope.workspaceId}`],
      );
      const rows = (
        await client.query(
          'SELECT id,label FROM execution_rules WHERE "ownerId"=$1 AND "workspaceId"=$2 ORDER BY position,id',
          [scope.ownerId, scope.workspaceId],
        )
      ).rows;
      let ids: string[] = rows.filter((r) => r.label !== null).map((r) => r.id);
      if (operation.kind === "reorder") {
        if (!z.array(z.uuid()).safeParse(operation.ids).success)
          throw new ActionFailureError("executionRuleOrderInvalid");
        if (
          new Set(operation.ids).size !== ids.length ||
          operation.ids.length !== ids.length ||
          operation.ids.some((id) => !ids.includes(id))
        )
          throw new ActionFailureError("executionRuleOrderInvalid");
        ids = operation.ids;
      } else if (operation.kind === "delete") {
        if (!ids.includes(operation.id))
          throw new ActionFailureError("executionRuleNotFound");
        await client.query(
          'DELETE FROM execution_rules WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',
          [operation.id, scope.ownerId, scope.workspaceId],
        );
        ids = ids.filter((id) => id !== operation.id);
      } else {
        const parsed = ruleInput.safeParse(operation.value);
        if (!parsed.success) {
          const field = parsed.error.issues[0]?.path[0];
          throw new ActionFailureError(
            field === "place"
              ? "executionPlaceInvalid"
              : field === "harness"
                ? "executionHarnessUnavailable"
                : field === "model"
                  ? "executionModelUnknown"
                  : "validationGeneric",
          );
        }
        const value = parsed.data;
        if (operation.id !== "default" && !value.label)
          throw new ActionFailureError("validationGeneric");
        if (operation.id === "default") value.label = null;
        if (value.place !== "cloud") {
          const device = await client.query(
            `SELECT id,harnesses FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL`,
            [value.place, scope.ownerId],
          );
          if (!device.rowCount)
            throw new ActionFailureError("executionPlaceInvalid");
          const available = z
            .array(
              z.object({
                harness: z.string(),
                installed: z.boolean(),
                models: z.array(z.string()).optional(),
                modelSlots: z.array(z.object({ slot: z.string() })).optional(),
              }),
            )
            .safeParse(device.rows[0].harnesses);
          const harnesses = available.success
            ? available.data.filter(
                (h) => h.installed && h.harness === value.harness,
              )
            : [];
          if (!harnesses.length)
            throw new ActionFailureError("executionHarnessUnavailable");
          if (
            !harnesses.some(
              (h) =>
                h.models?.includes(value.model) ||
                h.modelSlots?.some((s) => s.slot === value.model),
            )
          )
            throw new ActionFailureError("executionModelUnknown");
        }
        if (value.place === "cloud") {
          const models = await client.query(
            `SELECT b.id FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId"
            AND c."ownerId"=b."ownerId" AND c."workspaceId"=b."workspaceId" AND c.epoch=b."connectionRevision" AND c.state='connected'
            WHERE b."ownerId"=$1 AND b."workspaceId"=$2 AND b."modelId"=$3 AND c.provider=CASE WHEN $4='claude_code' THEN 'claude' WHEN $4='codex' THEN 'codex' END`,
            [scope.ownerId, scope.workspaceId, value.model, value.harness],
          );
          if (!models.rowCount)
            throw new ActionFailureError("executionModelUnknown");
        }
        const id =
          operation.id === "default"
            ? (rows.find((r) => r.label === null)?.id ?? randomUUID())
            : (operation.id ?? randomUUID());
        if (
          operation.id &&
          !(operation.id === "default" && !rows.some((r) => r.label === null))
        ) {
          if (operation.id !== "default" && !ids.includes(id))
            throw new ActionFailureError("executionRuleNotFound");
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
              operation.id === "default" ? 2147483647 : ids.length,
            ],
          );
          if (operation.id !== "default") ids.push(id);
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
  async places(
    scope: ExecutionSettingsScope,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    const { rows } = await query.query(
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
    if (!z.uuid().safeParse(deviceId).success) throw new ActionFailureError("executionPlaceInvalid");
    const id = await enqueueDeviceCommand(
      scope.ownerId,
      deviceId,
      "redetect",
      this.pool,
    );
    if (!id) throw new ActionFailureError("executionPlaceInvalid");
    return { commandId: id };
  }
  async redetectStatus(scope: ExecutionSettingsScope, commandId: string) {
    if (!z.uuid().safeParse(commandId).success) throw new ActionFailureError("executionCommandNotFound");
    const { rows: [row] } = await this.pool.query(
      `SELECT c.id AS "commandId",c."completedAt",c.error FROM device_management_commands c
       JOIN devices d ON d.id=c."deviceId" WHERE c.id=$1 AND c.kind='redetect'
       AND d."ownerId"=$2 AND d.kind='local' AND d."removedAt" IS NULL`, [commandId, scope.ownerId]);
    if (!row) throw new ActionFailureError("executionCommandNotFound");
    return { commandId: row.commandId, status: row.completedAt ? row.error ? "failed" as const : "completed" as const : "pending" as const,
      completedAt: row.completedAt?.toISOString() ?? null, error: row.error ?? null };
  }
  /** The workspace database owns issue-to-workspace links; never infer them from the issue owner. */
  async labels(scope: ExecutionSettingsScope) {
    const { issueTeamScope } = await import("./issue-team-access");
    const links = (await issueTeamScope(scope.ownerId)).filter(link => link.workspaceId === scope.workspaceId);
    if (!links.length) return [];
    const { rows } = await this.pool.query<{content: JSONContent}>(
      `SELECT content FROM issues WHERE id=ANY($1::uuid[]) AND scope='workspace' ORDER BY "updatedAt" DESC,id`, [links.map(link => link.issueId)]);
    const labels = new Map<string, {name: string; color: string}>();
    for (const row of rows) {
      const metadata = readIssueMetadata(row.content);
      if (metadata.deletedAt) continue;
      for (const label of metadata.labels) if (!labels.has(label.name.toLowerCase())) labels.set(label.name.toLowerCase(), label);
    }
    return [...labels.values()].sort((a,b) => a.name.localeCompare(b.name));
  }
  /** The owner's connected subscriptions, from any workspace: a subscription belongs to the account.
   * None unless the owner shared them into this workspace and its admin allows it (decision 2026-10-31-2225). */
  private async connectedBindings(
    scope: ExecutionSettingsScope,
    bindingId?: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    if (!(await subscriptionsUsable(query, scope.ownerId, scope.workspaceId))) return [];
    return (
      await query.query(
        `SELECT b.id AS "bindingId",b."consumerId",b."workspaceId",b."modelId",b.route,c.id AS "connectionId",c.provider,c."accountLabel",c.quota->>'plan' AS plan
       FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
       AND c.epoch=b."connectionRevision" AND c.state='connected'
       WHERE b."ownerId"=$1 AND b.route IN ('codex_cpa','claude_cpa','openai_siwc')
       AND ($3::uuid IS NULL OR b.id=$3)
       AND ($3::uuid IS NOT NULL OR c."modelCatalog" IS NULL OR c."modelCatalog"->>'revision'<>c.epoch::text OR c."modelCatalog"->'models' ? b."modelId") ORDER BY (b."workspaceId"=$2) DESC,b."createdAt" DESC,b.id`,
        [scope.ownerId, scope.workspaceId, bindingId ?? null],
      )
    ).rows;
  }
  /** False once the owner left or was suspended and the bot was archived (§8.3), or when it is not theirs. */
  async botActive(ownerId: string, botId: string) {
    return Boolean((await this.pool.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [botId, ownerId])).rowCount);
  }
  /** Execution resolves its saved binding independently of the deduplicated catalogue. */
  async botBinding(scope: ExecutionSettingsScope, bindingId: string) {
    return (await this.connectedBindings(scope, bindingId))[0];
  }
  /** One option per model/account. Binding lookups remain independent of this presentation deduplication. */
  async botModels(
    scope: ExecutionSettingsScope,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    const seen = new Set<string>();
    return (await this.connectedBindings(scope, undefined, query)).filter(
      (row) => {
        const key = JSON.stringify([row.connectionId, row.modelId]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
  }
  async refreshBotModels(scope: ExecutionSettingsScope, connectionId: string, discover?: (ownerId: string, connectionId: string) => Promise<{id: string; name?: string}[]>) {
    if (!z.uuid().safeParse(connectionId).success) throw new ActionFailureError("executionAccountUnavailable");
    const connection = (await this.pool.query(
      `SELECT id,epoch,provider,"workspaceId" FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND state='connected'`,
      [connectionId, scope.ownerId])).rows[0];
    if (!connection) throw new ActionFailureError("executionAccountUnavailable");
    let models: {id: string; name?: string}[];
    try {
      models = await (discover ?? (async (ownerId, id) => (await import("./subscription-runtime")).subscriptionRuntime().models(ownerId,id)))(scope.ownerId, connectionId);
    } catch { throw new ActionFailureError("executionAccountUnavailable"); }
    const unique = [...new Map(models.map(model => [model.id, model])).values()];
    const route = connection.provider === 'codex' ? 'codex_cpa' : 'claude_cpa';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT id FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND epoch=$3 AND state='connected' FOR UPDATE`, [connectionId,scope.ownerId,connection.epoch]);
      if (!current.rowCount) throw new ActionFailureError("executionAccountUnavailable");
      for (const model of unique) {
        if (!z.string().trim().min(1).max(128).safeParse(model.id).success) throw new ActionFailureError("executionModelUnknown");
        // Account-level catalogue: the id leaves out the workspace, and the row keeps the connection's own workspace.
        const hash = createHash('sha256').update(JSON.stringify([scope.ownerId,connectionId,connection.epoch,model.id])).digest('hex');
        const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
        await client.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`, [id,scope.ownerId,connection.workspaceId,id,connectionId,connection.epoch,route,model.id]);
      }
      await client.query(`UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1`, [connectionId,JSON.stringify({revision:String(connection.epoch),models:unique.map(model=>model.id)})]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const options = (await this.botModels(scope)).filter(row => row.connectionId === connectionId && unique.some(model => model.id === row.modelId));
    return options;
  }
  async setBotModel(
    scope: ExecutionSettingsScope,
    botId: string | null,
    bindingId: string | null,
  ) {
    if (botId !== null) {
      if (!z.uuid().safeParse(botId).success)
        throw new ActionFailureError("botNotFound");
      if (
        !(
          await this.pool.query(
            'SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',
            [botId, scope.ownerId, scope.workspaceId],
          )
        ).rowCount
      )
        throw new ActionFailureError("botNotFound");
    }
    const key = botId ?? "coordinator";
    if (bindingId === null || bindingId === "auto")
      throw new ActionFailureError("executionAutoNotAllowed");
    if (!z.uuid().safeParse(bindingId).success)
      throw new ActionFailureError("executionModelUnknown");
    const choice = (await this.connectedBindings(scope, bindingId)).find(
      (row) => row.bindingId === bindingId,
    );
    if (!choice) throw new ActionFailureError("executionModelUnknown");
    bindingId = await this.bindingForBot(scope, botId, bindingId);
    await this.pool.query(
      'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId"',
      [scope.ownerId, scope.workspaceId, key, bindingId],
    );
  }
  /** Clone only the owner's connected account reference, never a credential. The clone belongs to
   * the run's workspace, so membership, admission and the admin switch are checked there. */
  async bindingForBot(
    scope: ExecutionSettingsScope,
    botId: string | null,
    bindingId: string,
  ): Promise<string> {
    const source = (await this.connectedBindings(scope, bindingId)).find(
      (row) => row.bindingId === bindingId,
    );
    if (!source) throw new ActionFailureError("executionModelUnknown");
    if (source.workspaceId === scope.workspaceId && (botId === null || source.consumerId === botId)) return bindingId;
    const hash = createHash("sha256")
      .update(
        JSON.stringify([scope.ownerId, scope.workspaceId, botId ?? "coordinator", bindingId]),
      )
      .digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const result = await this.pool.query(
      `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      SELECT $1,b."ownerId",$4::text,$6::text,b."connectionId",b."connectionRevision",b.route,b."modelId" FROM byos_bindings b
      JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c.epoch=b."connectionRevision" AND c.state='connected'
      WHERE b.id=$5 AND b."ownerId"=$3
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots bot WHERE bot.id=$2::uuid AND bot."ownerId"=$3 AND bot."workspaceId"=$4::uuid))
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id`,
      [id, botId, scope.ownerId, scope.workspaceId, bindingId, botId ?? id],
    );
    if (!result.rows[0]) throw new ActionFailureError("executionModelUnknown");
    return result.rows[0].id;
  }
  /** UI selection follows its deduplicated option; execution keeps the stored binding id. */
  async botModelOption(scope: ExecutionSettingsScope, botId: string | null) {
    const bindingId = await this.botModel(scope, botId);
    if (!bindingId) return undefined;
    const saved = (await this.connectedBindings(scope,bindingId))[0];
    if (!saved) return bindingId;
    return (await this.botModels(scope)).find(option => option.connectionId === saved.connectionId && option.modelId === saved.modelId)?.bindingId ?? bindingId;
  }
  async botModel(
    scope: ExecutionSettingsScope,
    botId: string | null,
  ): Promise<string | undefined> {
    const saved = (
      await this.pool.query(
        'SELECT "bindingId" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [scope.ownerId, scope.workspaceId, botId ?? "coordinator"],
      )
    ).rows[0]?.bindingId;
    if (saved) return saved;
    // Decision 2026-10-30 (#537): a Claude subscription first, otherwise ChatGPT/Codex, as `suggested` does.
    const models = await this.botModels(scope);
    const first = models.find((m) => m.provider === "claude") ?? models[0];
    if (!first) return undefined;
    const bindingId = await this.bindingForBot(scope, botId, first.bindingId);
    await this.pool.query(
      'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO NOTHING',
      [scope.ownerId, scope.workspaceId, botId ?? "coordinator", bindingId],
    );
    return this.botModel(scope, botId);
  }
}

/** Bot scope is exact. Work with no bot of its own (the Coordinator's triage,
 * memory extraction) runs and bills in the owner's first active workspace, as
 * before: it is charged where it happens, never moved to a new personal
 * workspace (decision 2026-10-31-2225). */
export async function executionWorkspace(
  ownerId: string,
  botId: string | null,
): Promise<string> {
  const { pool } = await import("./db");
  if (botId) {
    const bot = (
      await pool.query(
        // An archived bot (its owner left or was suspended) runs nothing until an admin takes it over (§8.3).
        'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL',
        [botId, ownerId],
      )
    ).rows[0];
    if (!bot) throw new ActionFailureError("botNotFound");
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
  if (!workspace) throw new ActionFailureError("workspaceAccessDenied");
  return workspace.id;
}
