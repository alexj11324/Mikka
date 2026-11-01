import "server-only";
import type { Pool } from "pg";
import { z } from "zod";
import { ActionFailureError } from "./action-error";
import type { ExecutionSettings, ExecutionSettingsScope } from "./execution-settings";
import { apiKeyChatBaseUrl } from "./model-api-key-providers";
import { quotaExhausted, quotaResetsAt } from "./subscription-quota";

export { quotaExhausted } from "./subscription-quota";
import {
  apiKeyOptionId,
  HOSTED_CHOICE,
  type BotModelCurrent,
  type BotModelMenu,
  type BotModelMenuGroup,
} from "./bot-model-menu-view";

/**
 * The scope a chat's picker reads and saves in: the bot's own workspace, or
 * where the Coordinator runs. `freezeBotModel` resolves the same one, so the
 * chip shows what the next run uses. `onlyWorkspace` fences a workspace-bound token.
 */
export async function botModelScope(ownerId: string, botId: string | null, onlyWorkspace?: string): Promise<ExecutionSettingsScope> {
  if (botId !== null && !z.uuid().safeParse(botId).success) throw new ActionFailureError("botNotFound");
  const { executionWorkspace } = await import("./execution-settings");
  const workspaceId = await executionWorkspace(ownerId, botId);
  if (onlyWorkspace && onlyWorkspace !== workspaceId) throw new ActionFailureError("botNotFound");
  return { ownerId, workspaceId };
}

const HOSTED = { id: HOSTED_CHOICE, modelId: "", provider: "mikka" } as const;

/**
 * The composer's model menu for one bot, or the Coordinator (`botId` null),
 * and what its chip shows. It lists only credentials the resolver can use in
 * this workspace (`ExecutionSettings.botModels`), so the menu never offers a
 * model the next run would refuse. It reads; it never saves a default.
 */
export async function botModelMenu(
  pool: Pick<Pool, "query">,
  settings: Pick<ExecutionSettings, "botModels" | "botBinding">,
  scope: ExecutionSettingsScope,
  botId: string | null,
  now = Date.now(),
): Promise<BotModelMenu> {
  const rows = await settings.botModels(scope);
  const quotas = new Map<string, unknown>(
    rows.length
      ? (
          await pool.query<{ id: string; quota: unknown }>(
            "SELECT id::text AS id,quota FROM byos_connections WHERE id::text=ANY($1::text[])",
            [[...new Set(rows.map((row) => String(row.connectionId)))]],
          )
        ).rows.map((row) => [row.id, row.quota])
      : [],
  );
  // Claude first, then ChatGPT/Codex, as the resolver orders them (orchestration §2).
  const ordered = [
    ...rows.filter((row) => row.provider === "claude"),
    ...rows.filter((row) => row.provider !== "claude"),
  ];
  const subscriptions = new Map<string, BotModelMenuGroup>();
  for (const row of ordered) {
    const key = String(row.connectionId);
    const group: BotModelMenuGroup = subscriptions.get(key) ?? {
      kind: "subscription",
      provider: row.provider,
      plan: row.plan ?? null,
      options: [],
    };
    subscriptions.set(key, group);
    group.options.push({ id: row.bindingId, modelId: row.modelId, provider: row.provider });
  }
  // API keys and custom providers that reach bot chats (C22): the person's own, then teammates' shared ones.
  const { usableApiKeys, botApiKeyChoice } = await import("./model-api-keys");
  const keys = (await usableApiKeys(pool, scope.ownerId, scope.workspaceId)).filter((key) => apiKeyChatBaseUrl(key) && key.models.length);
  const keyOptions = (key: (typeof keys)[number]) =>
    key.models.map((model) => ({ id: apiKeyOptionId(key.id, model), modelId: model, provider: key.provider }));
  const ownKeys = keys.filter((key) => key.mine);
  const sharedOwners = [...new Set(keys.filter((key) => !key.mine).map((key) => key.ownerId))];
  const ownerNames = sharedOwners.length ? await memberNames(scope.workspaceId, sharedOwners) : new Map<string, string>();
  const groups: BotModelMenuGroup[] = [
    { kind: "hosted", options: [{ ...HOSTED }] },
    ...subscriptions.values(),
    ...(ownKeys.length ? [{ kind: "apiKey" as const, options: ownKeys.flatMap(keyOptions) }] : []),
    ...sharedOwners.filter((owner) => ownerNames.has(owner)).map((owner) => ({
      kind: "shared" as const, owner: ownerNames.get(owner)!, options: keys.filter((key) => key.ownerId === owner).flatMap(keyOptions),
    })),
  ];
  const keyChoice = await botApiKeyChoice(pool, scope, botId);

  const row = (
    await pool.query<{ bindingId: string | null }>(
      'SELECT "bindingId" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
      [scope.ownerId, scope.workspaceId, botId ?? "coordinator"],
    )
  ).rows[0];
  // A row without a binding is Mikka 默认, picked on purpose.
  const saved = row ? (row.bindingId ?? HOSTED_CHOICE) : undefined;

  const fromRow = (
    row: (typeof rows)[number],
    chosen: boolean,
    quota: unknown,
  ): BotModelCurrent => {
    // A bot's saved binding is its own copy; the menu lists one option per account and model.
    const option = rows.find(
      (item) => item.connectionId === row.connectionId && item.modelId === row.modelId,
    );
    const exhausted = quotaExhausted(quota, now);
    return {
      id: option?.bindingId ?? row.bindingId,
      modelId: row.modelId,
      provider: row.provider,
      kind: "subscription",
      chosen,
      available: !exhausted,
      ...(exhausted ? { quota: { plan: (row as { plan?: string | null }).plan ?? null, resetsAt: quotaResetsAt(quota, now), fallback: null } } : {}),
    };
  };

  let current: BotModelCurrent;
  if (keyChoice) {
    // A saved API key model; unavailable once the key is deleted, unshared or not allowed here.
    const key = keys.find((item) => item.id === keyChoice.keyId);
    current = {
      id: apiKeyOptionId(keyChoice.keyId, keyChoice.model),
      modelId: keyChoice.model,
      provider: key?.provider ?? "unknown",
      kind: key && !key.mine ? "shared" : "apiKey",
      chosen: true,
      available: Boolean(key),
    };
  } else if (saved === HOSTED_CHOICE) {
    current = { ...HOSTED, kind: "hosted", chosen: true, available: true };
  } else if (saved) {
    const live = await settings.botBinding(scope, saved);
    if (live)
      current = fromRow(live, true, quotas.get(String(live.connectionId)) ?? (await connectionQuota(pool, live.connectionId)));
    else {
      // Disconnected, revoked, unshared or not allowed here any more: name it, marked unavailable.
      const gone = (
        await pool.query<{ modelId: string; provider: string }>(
          `SELECT b."modelId",c.provider FROM byos_bindings b LEFT JOIN byos_connections c ON c.id=b."connectionId"
           WHERE b.id=$1 AND b."ownerId"=$2`,
          [saved, scope.ownerId],
        )
      ).rows[0];
      current = {
        id: saved,
        modelId: gone?.modelId ?? "",
        provider: gone?.provider ?? "unknown",
        kind: "subscription",
        chosen: true,
        available: false,
      };
    }
  } else {
    // Nothing picked: what the resolver gives the next run (orchestration §2).
    const first = ordered[0];
    current = first
      ? fromRow(first, false, quotas.get(String(first.connectionId)))
      : { ...HOSTED, kind: "hosted", chosen: false, available: true };
  }
  // Out of quota: the key the next turn moves to, when 订阅额度用完后，自动改用 API Key allows it (freezeBotModel decides the same way).
  if (current.quota) {
    const { quotaFallbackKey } = await import("./quota-fallback");
    const fallback = await quotaFallbackKey(pool, scope.ownerId, scope.workspaceId, current.modelId);
    if (fallback) current.quota.fallback = { keyProvider: fallback.key.provider, keyName: fallback.key.name, model: fallback.model };
  }
  return { groups, current };
}

/** Active members' names, for 「{name} 的 Key」 headings. Never the credential. */
async function memberNames(workspaceId: string, userIds: string[]) {
  const [{ workspaceDb }, { workspaceMembers }, { and, eq, inArray }] = await Promise.all([
    import("./workspace-db"), import("./db/workspace-schema"), import("drizzle-orm"),
  ]);
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds), eq(workspaceMembers.status, "active")));
  return new Map(rows.map((row) => [row.userId, row.name]));
}

async function connectionQuota(pool: Pick<Pool, "query">, connectionId: string) {
  return (
    await pool.query("SELECT quota FROM byos_connections WHERE id::text=$1", [String(connectionId)])
  ).rows[0]?.quota;
}

/**
 * 刷新模型列表: asks each subscription the menu lists for its current models
 * (`refreshBotModels`), then reads the menu again, so a new subscription, a
 * renewed quota or a new model shows at once. A provider that does not answer
 * in time keeps its last catalogue; the menu is still re-read.
 */
export async function refreshBotModelMenu(
  pool: Pick<Pool, "query">,
  settings: Pick<ExecutionSettings, "botModels" | "botBinding" | "refreshBotModels">,
  scope: ExecutionSettingsScope,
  botId: string | null,
  timeoutMs = 8000,
): Promise<BotModelMenu> {
  const connections = [...new Set((await settings.botModels(scope)).map((row) => String(row.connectionId)))];
  await Promise.allSettled(
    connections.map((connectionId) =>
      Promise.race([
        settings.refreshBotModels(scope, connectionId),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]),
    ),
  );
  return botModelMenu(pool, settings, scope, botId);
}
