import "server-only";
import type { Pool } from "pg";
import { quotaWindowSchema } from "@mikka/protocol";
import { z } from "zod";
import { ActionFailureError } from "./action-error";
import type { ExecutionSettings, ExecutionSettingsScope } from "./execution-settings";
import {
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

/** A subscription is out of quota while an account-wide window is fully used and has not reset. */
export function quotaExhausted(quota: unknown, now = Date.now()) {
  const parsed = z.object({ windows: z.array(quotaWindowSchema) }).safeParse(quota);
  if (!parsed.success) return false;
  return parsed.data.windows.some(
    (window) =>
      !window.model &&
      window.used >= 1 &&
      (!window.resetsAt || !(Date.parse(window.resetsAt) <= now)),
  );
}

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
  const apiKeys = new Map<string, BotModelMenuGroup>();
  for (const row of ordered) {
    const key = String(row.connectionId);
    // A workspace-added API-key model is its own group kind; subscriptions group by account.
    const collection = row.provider === "apiKey" ? apiKeys : subscriptions;
    const group: BotModelMenuGroup = collection.get(key) ?? {
      kind: row.provider === "apiKey" ? "apiKey" : "subscription",
      provider: row.provider,
      plan: row.plan ?? null,
      options: [],
    };
    collection.set(key, group);
    group.options.push({ id: row.bindingId, modelId: row.modelId, provider: row.provider });
  }
  const groups: BotModelMenuGroup[] = [
    { kind: "hosted", options: [{ ...HOSTED }] },
    ...subscriptions.values(),
    ...apiKeys.values(),
  ];

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
    return {
      id: option?.bindingId ?? row.bindingId,
      modelId: row.modelId,
      provider: row.provider,
      kind: row.provider === "apiKey" ? "apiKey" : "subscription",
      chosen,
      available: !quotaExhausted(quota, now),
    };
  };

  let current: BotModelCurrent;
  if (saved === HOSTED_CHOICE) {
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
  return { groups, current };
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
