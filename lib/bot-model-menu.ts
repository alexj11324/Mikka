import "server-only";
import { hostedModelEnabled } from "./enabled-models";
import type { Pool } from "pg";
import { z } from "zod";
import { ActionFailureError } from "./action-error";
import type { ExecutionSettings, ExecutionSettingsScope } from "./execution-settings";
import { apiKeyChatBaseUrl } from "./model-api-key-providers";
import { subscriptionAvailability } from "./subscription-quota";
import { botModelPreference, resolveBotModelChoice } from "./bot-model-choice";
import { isCloudEdition } from "./edition";
import { defaultModelTarget } from "./default-model";

export { quotaExhausted } from "./subscription-quota";
import {
  apiKeyOptionId,
  creditsOptionId,
  NO_MODEL,
  type BotModelCurrent,
  type BotModelMenuOption,
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


/**
 * The composer's model menu for one bot, or the Coordinator (`botId` null),
 * and what its chip shows. It lists only credentials the resolver can use in
 * this workspace (`ExecutionSettings.chatModels`), so the menu never offers a
 * model the next run would refuse. It reads; it never saves a default.
 */
export async function botModelMenu(
  pool: Pick<Pool, "query">,
  settings: Pick<ExecutionSettings, "botModels" | "chatModels" | "chatBinding">,
  scope: ExecutionSettingsScope,
  botId: string | null,
  now = Date.now(),
  inspectPreference = false,
): Promise<BotModelMenu & { preferenceState?: "absent" | "present" }> {
  const [{ usableApiKeys }, { hostedPointsHere }, { creditsModels }] = await Promise.all([
    import("./model-api-keys"), import("./points-fallback"), import("./credits-models"),
  ]);
  const local = !isCloudEdition();
  const subscriptionsRead = settings.botModels(scope).then(async allRows => {
    const rows = await settings.chatModels(scope, pool, allRows);
    return { allRows, rows };
  });
  const keysRead = usableApiKeys(pool, scope.ownerId, scope.workspaceId).then(allKeys => {
    const keys = allKeys.filter((key) => apiKeyChatBaseUrl(key) && key.models.length);
    return { allKeys, keys };
  });
  const pointsRead = local ? Promise.resolve({ points: 0 }) : hostedPointsHere(scope.workspaceId);
  const enabledRead = (async () => {
    const target = local ? await defaultModelTarget(scope.ownerId) : null;
    return await hostedModelEnabled(pool, scope.ownerId) && (!local || target !== null);
  })();
  const preferenceRead = botModelPreference(pool, scope, botId);
  const catalogueRead = enabledRead.then(enabled => enabled ? creditsModels(scope.ownerId) : []);
  const ownerNamesRead = keysRead.then(({ keys }) => {
    const sharedOwners = [...new Set(keys.filter((key) => !key.mine).map((key) => key.ownerId))];
    return sharedOwners.length ? memberNames(scope.workspaceId, sharedOwners) : new Map<string, string>();
  });
  const choiceRead = Promise.all([subscriptionsRead, keysRead, preferenceRead]).then(([{ allRows, rows }, { allKeys, keys }, preference]) =>
    resolveBotModelChoice(pool, settings, scope, botId, preference, { rows, keys, now, fallback: { rows: allRows, keys: allKeys } }));
  const [{ rows }, { keys }, { points }, enabled, preference, catalogue, ownerNames, choice] = await Promise.all([
    subscriptionsRead, keysRead, pointsRead, enabledRead, preferenceRead, catalogueRead, ownerNamesRead, choiceRead,
  ]);
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
      credentialLabel: row.accountLabel?.trim() || `…${String(row.connectionId).slice(-6)}`,
      options: [],
    };
    subscriptions.set(key, group);
    group.options.push({ id: row.bindingId, modelId: row.modelId, provider: row.provider });
  }
  // API keys and custom providers that reach bot chats (C22): the person's own, then teammates' shared ones.
  const keyOptions = (key: (typeof keys)[number]) =>
    key.models.map((model) => ({ id: apiKeyOptionId(key.id, model), modelId: model, provider: key.provider }));
  const keyLabel = (key: (typeof keys)[number]) => [key.name, key.last4 ? `····${key.last4}` : null].filter(Boolean).join(" ") || key.provider;
  const ownKeys = keys.filter((key) => key.mine);
  // Mikka 额度: every catalogue model, listed whenever the source is on; the balance is checked when a message is sent
  // (decision 2026-11-15-1900). A self-hosted server lists its LiteLLM default alias.
  const usable = enabled && (local || points > 0);
  const hostedSource = local ? "self-hosted" as const : undefined;
  const creditsOption = (model: { id: string; name?: string; pricing?: { input: number; output: number } | null }, featured?: boolean): BotModelMenuOption => ({
    id: creditsOptionId(model.id), modelId: model.id, provider: "mikka", ...(model.name ? { name: model.name } : {}),
    ...(model.pricing ? { price: { input: model.pricing.input, output: model.pricing.output } } : {}),
    ...(featured ? { featured } : {}), ...(hostedSource ? { hostedSource } : {}),
  });
  const { FEATURED_MODELS } = await import("./model-catalog");
  const featured = new Set<string>(FEATURED_MODELS);
  const groups: BotModelMenuGroup[] = [
    ...(catalogue.length ? [{ kind: "hosted" as const, ...(hostedSource ? { hostedSource } : { points }),
      options: catalogue.map((model) => creditsOption(model, local || featured.has(model.id))) }] : []),
    ...subscriptions.values(),
    ...ownKeys.map((key) => ({ kind: "apiKey" as const, credentialLabel: keyLabel(key), options: keyOptions(key) })),
    ...keys.filter((key) => !key.mine && ownerNames.has(key.ownerId)).map((key) => ({
      kind: "shared" as const, owner: ownerNames.get(key.ownerId)!, credentialLabel: keyLabel(key), options: keyOptions(key),
    })),
  ];
  const state = { chosen: choice.chosen, ...(choice.fallback ? { fallback: choice.fallback } : {}) };
  let current: BotModelCurrent;
  if (choice.kind === "none") {
    current = { ...NO_MODEL, ...state };
  } else if (choice.kind === "hosted") {
    const model = catalogue.find((item) => item.id === choice.model) ?? { id: choice.model };
    current = { ...creditsOption(model, featured.has(choice.model)), kind: "hosted", ...state, available: usable, availability: usable ? "available" : "exhausted" };
  } else if (choice.kind === "apiKey") {
    current = {
      id: apiKeyOptionId(choice.key.id, choice.model), modelId: choice.model, provider: choice.key.provider,
      kind: choice.key.mine ? "apiKey" : "shared", ...state, available: true, availability: "available",
      credentialLabel: choice.key.mine ? keyLabel(choice.key) : [ownerNames.get(choice.key.ownerId), keyLabel(choice.key)].filter(Boolean).join(" · "),
      ...(choice.quota ? { quota: choice.quota } : {}),
    };
  } else {
    const binding = choice.binding;
    const option = rows.find(item => item.connectionId === binding.connectionId && item.modelId === binding.modelId);
    const availability = subscriptionAvailability(binding.quota, binding.modelId, binding.provider === "codex" ? "codex" : "claude", now);
    current = {
      id: option?.bindingId ?? binding.bindingId, modelId: binding.modelId, provider: binding.provider,
      kind: "subscription", ...state, available: availability.status === "available", availability: availability.status,
      credentialLabel: binding.accountLabel?.trim() || `…${String(binding.connectionId).slice(-6)}`,
      ...(choice.quota ? { quota: choice.quota } : {}),
    };
  }
  return { groups, current, ...(inspectPreference ? { preferenceState: !preference.key && preference.selected === undefined ? "absent" as const : "present" as const } : {}) };
}

/** Active members' public names for shared API keys. Never the credential. */
async function memberNames(workspaceId: string, userIds: string[]) {
  const [{ workspaceDb }, { workspaceMembers }, { and, eq, inArray }] = await Promise.all([
    import("./workspace-db"), import("./db/workspace-schema"), import("drizzle-orm"),
  ]);
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, userIds), eq(workspaceMembers.status, "active")));
  return new Map(rows.map((row) => [row.userId, row.name]));
}

/**
 * 刷新模型列表: asks each connected subscription for its current models
 * (`refreshBotModels`), then reads the menu again, so a new subscription, a
 * renewed quota or a new model shows at once. A provider that does not answer
 * in time keeps its last catalogue; the menu is still re-read.
 */
export async function refreshBotModelMenu(
  pool: Pick<Pool, "query">,
  settings: Pick<ExecutionSettings, "botModels" | "chatModels" | "chatBinding" | "refreshBotModels" | "connectedSubscriptions">,
  scope: ExecutionSettingsScope,
  botId: string | null,
  timeoutMs = 8000,
  refreshQuota: (ownerId: string, connectionId: string, signal: AbortSignal) => Promise<unknown> = async (ownerId, connectionId, signal) =>
    (await import("./subscription-runtime")).subscriptionRuntime().usage(ownerId, connectionId, signal),
): Promise<BotModelMenu> {
  // Every connected subscription, not only those already listed: one never asked has no models to list yet.
  const connections = await settings.connectedSubscriptions(scope.ownerId);
  await Promise.allSettled(
    connections.map((connectionId) =>
      Promise.race([
        // A catalogue read alone cannot confirm a stale allowance. The same
        // refresh checks usage, whose safe snapshot is persisted by the service.
        Promise.allSettled([
          settings.refreshBotModels(scope, connectionId),
          refreshQuota(scope.ownerId, connectionId, AbortSignal.timeout(timeoutMs)),
        ]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
      ]),
    ),
  );
  return botModelMenu(pool, settings, scope, botId);
}

/**
 * Saves a chat's model pick for the bot's next runs (a run already going keeps
 * its model) and returns the menu: a binding id, a Mikka 额度 model (`credits:<vendor/model>`), or
 * an API key model (`apikey:<keyId>:<model>`, saved as that key's choice). The
 * web's action and the iOS app's route both save through here, so every option
 * the menu lists can be picked from either.
 */
export async function chooseBotModel(
  pool: Pool,
  settings: ExecutionSettings,
  scope: ExecutionSettingsScope,
  botId: string | null,
  id: string,
): Promise<BotModelMenu> {
  const { parseApiKeyOption } = await import("./bot-model-menu-view");
  const apiKey = parseApiKeyOption(id);
  if (apiKey) {
    const { setBotApiKeyChoice } = await import("./model-api-keys");
    const { WorkspaceError } = await import("./workspace-error");
    try {
      await setBotApiKeyChoice(pool, scope, botId, apiKey.keyId, apiKey.model);
    } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(error.code === "botNotFound" ? "botNotFound" : "executionModelUnknown");
      throw error;
    }
  } else await settings.setBotModel(scope, botId, id);
  return botModelMenu(pool, settings, scope, botId);
}
