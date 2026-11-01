import "server-only";
import { pool } from "./db";
import { ActionFailureError } from "./action-error";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { COORDINATOR_MODEL } from "./coordinator/model";
import { HOSTED_CHOICE } from "./bot-model-menu-view";
import { botApiKeyChoice, usableApiKeys } from "./model-api-keys";
import { apiKeyChatBaseUrl } from "./model-api-key-providers";
import { quotaExhausted } from "./subscription-quota";
import {
  freezeHostedModelSelection,
  hostedApiKeySnapshotSchema,
  type HostedModelDependencies,
  type HostedModelScope,
  type HostedRuntimeSnapshot,
} from "./subscription-model-snapshot";

/** Runs inside the first reservation callback; replays keep their frozen choice. */
export async function freezeBotModel(
  scope: HostedModelScope,
  dependencies: HostedModelDependencies,
): Promise<HostedRuntimeSnapshot> {
  const workspaceId =
    scope.workspaceId ?? (await executionWorkspace(scope.ownerId, scope.botId));
  const settings = new ExecutionSettings(pool);
  // An archived bot (its owner left or was suspended) runs nothing until an admin takes it over (§8.3).
  if (scope.botId && !(await settings.botActive(scope.ownerId, scope.botId)))
    throw new ActionFailureError("botNotFound");
  const settingsScope = { ownerId: scope.ownerId, workspaceId };
  // A saved API key model (C22) runs while that key is still usable here; otherwise the usual order below.
  const keyChoice = await botApiKeyChoice(pool, settingsScope, scope.botId);
  if (keyChoice) {
    const key = (await usableApiKeys(pool, scope.ownerId, workspaceId)).find((row) => row.id === keyChoice.keyId);
    if (key && apiKeyChatBaseUrl(key))
      return {
        harness: "ai_sdk",
        model: keyChoice.model,
        modelSelection: hostedApiKeySnapshotSchema.parse({
          ...(scope.botId === null ? { coordinator: true } : { consumerId: scope.botId }),
          type: "api_key", keyId: key.id, ownerId: scope.ownerId, workspaceId, modelId: keyChoice.model,
        }),
      };
  }
  /**
   * 订阅额度用完后，自动改用 API Key: a subscription known to be out of quota
   * hands this whole turn to the person's own key, decided here at its start
   * and never mid-turn. The snapshot says so, and the chat shows it.
   */
  const afterQuota = async (row: { modelId: string; provider: string; plan?: string | null; quota?: unknown }) => {
    if (!quotaExhausted(row.quota)) return null;
    const { quotaFallbackKey } = await import("./quota-fallback");
    const fallback = await quotaFallbackKey(pool, scope.ownerId, workspaceId, row.modelId);
    if (!fallback) return null;
    return {
      harness: "ai_sdk",
      model: fallback.model,
      modelSelection: hostedApiKeySnapshotSchema.parse({
        ...(scope.botId === null ? { coordinator: true } : { consumerId: scope.botId }),
        type: "api_key", keyId: fallback.key.id, ownerId: scope.ownerId, workspaceId, modelId: fallback.model,
        afterQuota: {
          subscription: row.provider === "codex" ? "codex" : "claude",
          plan: row.plan ?? null,
          keyProvider: fallback.key.provider,
          keyName: fallback.key.name,
        },
      }),
    } satisfies HostedRuntimeSnapshot;
  };
  const selected = await settings.botModel(settingsScope, scope.botId);
  // Mikka 默认 picked in the composer: the hosted model, whatever else is connected.
  if (selected === HOSTED_CHOICE) return { harness: "ai_sdk", model: COORDINATOR_MODEL };
  const available = await settings.botModels(settingsScope);
  // A saved choice whose account was disconnected or signed in again is no longer bound:
  // take a bound subscription (Claude first), otherwise Mikka 默认, the hosted model (decision 2026-10-31-2110).
  const binding =
    (selected ? await settings.botBinding(settingsScope, selected) : undefined) ??
    available.find((row) => row.provider === "claude") ??
    available[0];
  if (!binding && scope.botId) {
    // The owner has none here: another member's subscription shared with 分享给团队成员 (Alex, 「B」).
    const pooled = (await settings.pooledBindings(settingsScope))[0];
    const switched = pooled && (await afterQuota(pooled));
    if (switched) return switched;
    if (pooled)
      return freezeHostedModelSelection(
        { ...scope, workspaceId },
        { harness: "ai_sdk", model: null },
        { type: "subscription", bindingId: await settings.bindingForOthersBot(settingsScope, scope.botId, pooled.ownerId, pooled.bindingId) },
        dependencies,
        pooled.ownerId,
      );
  }
  // No subscription bound: every bot, the Coordinator included, runs on the hosted default
  // through the same admission (verified card, allowance) and workspace billing.
  if (!binding) return { harness: "ai_sdk", model: COORDINATOR_MODEL };
  const switched = await afterQuota(binding);
  if (switched) return switched;
  return freezeHostedModelSelection(
    { ...scope, workspaceId },
    { harness: "ai_sdk", model: null },
    {
      type: "subscription",
      bindingId: await settings.bindingForBot(
        settingsScope,
        scope.botId,
        binding.bindingId,
      ),
    },
    dependencies,
  );
}
