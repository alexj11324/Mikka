import "server-only";
import { ActionFailureError } from "./action-error";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { othersMayUse, pooledOwners } from "./personal-policy";
import { HOSTED_CHOICE } from "./bot-model-menu-view";

export interface ExecutionSettingsScope {
  ownerId: string;
  workspaceId: string;
}
/** Callers obtain scope from the session and current workspace, never from input. */
export class ExecutionSettings {
  constructor(readonly pool: Pool) {}
  /** The owner's connected subscriptions, from any workspace: a subscription belongs to the account,
   * and its owner may always use it here (decision 2026-11-01-2240). Membership is the caller's check. */
  private async connectedBindings(
    scope: ExecutionSettingsScope,
    bindingId?: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    return this.bindingsOf(scope.ownerId, scope.workspaceId, bindingId, query);
  }
  private async bindingsOf(
    ownerId: string,
    workspaceId: string,
    bindingId?: string,
    query: Pick<PoolClient, "query"> = this.pool,
  ) {
    return (
      await query.query(
        `SELECT b.id AS "bindingId",b."ownerId",b."consumerId",b."workspaceId",b."modelId",b.route,c.id AS "connectionId",c.provider,c."accountLabel",c.quota->>'plan' AS plan,c.quota
       FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
       AND c.epoch=b."connectionRevision" AND c.state='connected' AND c.paused=false
       WHERE b."ownerId"=$1 AND b.route IN ('codex_cpa','claude_cpa','openai_siwc')
       AND ($3::uuid IS NULL OR b.id=$3)
       AND ($3::uuid IS NOT NULL OR c."modelCatalog" IS NULL OR c."modelCatalog"->>'revision'<>c.epoch::text OR c."modelCatalog"->'models' ? b."modelId") ORDER BY (b."workspaceId"=$2) DESC,b."createdAt" DESC,b.id`,
        [ownerId, workspaceId, bindingId ?? null],
      )
    ).rows;
  }
  /**
   * For a bot whose owner has no subscription here: other members' subscriptions
   * shared with 分享给团队成员 (Alex, 「B」), Claude first, then by the oldest
   * share. Only ever offered to the resolver, never listed to the bot's owner.
   */
  async pooledBindings(scope: ExecutionSettingsScope) {
    const rows = [];
    for (const ownerId of await pooledOwners(this.pool, scope.ownerId, scope.workspaceId))
      rows.push(...(await this.bindingsOf(ownerId, scope.workspaceId)));
    return [...rows.filter((row) => row.provider === "claude"), ...rows.filter((row) => row.provider !== "claude")];
  }
  /** Clone another member's binding for this bot only, while they allow it here; never a credential. */
  async bindingForOthersBot(scope: ExecutionSettingsScope, botId: string, subscriptionOwnerId: string, bindingId: string) {
    if (subscriptionOwnerId === scope.ownerId || !(await othersMayUse(this.pool, subscriptionOwnerId, scope.workspaceId)))
      throw new ActionFailureError("executionModelUnknown");
    const hash = createHash("sha256").update(JSON.stringify([subscriptionOwnerId, scope.workspaceId, botId, bindingId])).digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const result = await this.pool.query(
      `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      SELECT $1,b."ownerId",$4::text,$2::text,b."connectionId",b."connectionRevision",b.route,b."modelId" FROM byos_bindings b
      JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c.epoch=b."connectionRevision" AND c.state='connected' AND c.paused=false
      JOIN bots bot ON bot.id=$2::uuid AND bot."ownerId"=$3 AND bot."workspaceId"=$4::uuid AND bot."archivedAt" IS NULL
      WHERE b.id=$5 AND b."ownerId"=$6 AND b.route IN ('codex_cpa','claude_cpa','openai_siwc')
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id`,
      [id, botId, scope.ownerId, scope.workspaceId, bindingId, subscriptionOwnerId],
    );
    if (!result.rows[0]) throw new ActionFailureError("executionModelUnknown");
    return result.rows[0].id as string;
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
  /** The owner's connected subscriptions (any workspace); `missingOnly`: those with no catalogue for their current revision yet. */
  async connectedSubscriptions(ownerId: string, missingOnly = false): Promise<string[]> {
    return (await this.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM byos_connections WHERE "ownerId"=$1 AND state='connected' AND paused=false AND "removedAt" IS NULL
       AND ($2::boolean=false OR "modelCatalog" IS NULL OR "modelCatalog"->>'revision'<>epoch::text) ORDER BY id`,
      [ownerId, missingOnly])).rows.map((row) => row.id);
  }
  /**
   * A subscription's models reach the menu, 允许使用的模型 and dispatch only through its catalogue.
   * Each connected subscription with none for its current revision asks its account once; one that
   * does not answer in time is asked again on the next read. Never throws.
   */
  async ensureCatalogues(scope: ExecutionSettingsScope, timeoutMs = 8000, discover?: (ownerId: string, connectionId: string) => Promise<{id: string; name?: string}[]>) {
    const missing = await this.connectedSubscriptions(scope.ownerId, true);
    await Promise.allSettled(missing.map((connectionId) => Promise.race([
      // The reason only (a refusal code or error name), never what the provider answered.
      this.refreshBotModels(scope, connectionId, discover).catch((error: unknown) => {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.name : "unknown";
        console.warn(JSON.stringify({ level: "warn", msg: "subscription_catalogue_failed", connection: connectionId.slice(0, 8), code }));
      }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ])));
  }
  async refreshBotModels(scope: ExecutionSettingsScope, connectionId: string, discover?: (ownerId: string, connectionId: string) => Promise<{id: string; name?: string}[]>) {
    if (!z.uuid().safeParse(connectionId).success) throw new ActionFailureError("executionAccountUnavailable");
    const connection = (await this.pool.query(
      `SELECT id,epoch,provider,"workspaceId" FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND state='connected' AND paused=false`,
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
      const current = await client.query(`SELECT id FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND epoch=$3 AND state='connected' AND paused=false FOR UPDATE`, [connectionId,scope.ownerId,connection.epoch]);
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
    // Mikka 默认 picked on purpose: no binding behind it (decision 2026-10-31-2330).
    if (bindingId === HOSTED_CHOICE) {
      await this.pool.query(
        // The pick replaces an API key model saved before, as a subscription pick does; else the key choice wins on read.
        'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId","apiKeyId"=NULL,"apiKeyModel"=NULL',
        [scope.ownerId, scope.workspaceId, key, null],
      );
      return;
    }
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
      'INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,$3,$4) ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET "bindingId"=EXCLUDED."bindingId","apiKeyId"=NULL,"apiKeyModel"=NULL',
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
      JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c.epoch=b."connectionRevision" AND c.state='connected' AND c.paused=false
      WHERE b.id=$5 AND b."ownerId"=$3
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots bot WHERE bot.id=$2::uuid AND bot."ownerId"=$3 AND bot."workspaceId"=$4::uuid))
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id`,
      [id, botId, scope.ownerId, scope.workspaceId, bindingId, botId ?? id],
    );
    if (!result.rows[0]) throw new ActionFailureError("executionModelUnknown");
    return result.rows[0].id;
  }
  async botModel(
    scope: ExecutionSettingsScope,
    botId: string | null,
  ): Promise<string | undefined> {
    const row = (
      await this.pool.query(
        'SELECT "bindingId","apiKeyId" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [scope.ownerId, scope.workspaceId, botId ?? "coordinator"],
      )
    ).rows[0];
    if (row?.bindingId) return row.bindingId;
    // The saved choice is an API key's model (lib/model-api-keys.ts botApiKeyChoice), not a binding.
    if (row?.apiKeyId) return undefined;
    // A saved row without either is Mikka 默认, picked on purpose.
    if (row) return HOSTED_CHOICE;
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
