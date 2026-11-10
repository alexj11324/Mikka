import "server-only";
import { pool } from "./db";
import { ActionFailureError } from "./action-error";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { COORDINATOR_MODEL } from "./coordinator/model";
import { botApiKeyChoice, usableApiKeys } from "./model-api-keys";
import { apiKeyServesBotModel, resolveBotModelChoice } from "./bot-model-choice";
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
  const keyChoice = await botApiKeyChoice(pool, settingsScope, scope.botId);
  const keys = await usableApiKeys(pool, scope.ownerId, workspaceId);
  // botModel creates the initial per-bot binding; a valid saved key keeps its
  // existing precedence and needs no subscription default written.
  const savedKey = keyChoice && keys.find(key => key.id === keyChoice.keyId && apiKeyServesBotModel(key, keyChoice.model));
  const selected = savedKey ? undefined : await settings.botModel(settingsScope, scope.botId);
  const choice = await resolveBotModelChoice(pool, settings, settingsScope, scope.botId,
    { selected, key: keyChoice }, { keys });
  // A disappeared/revoked explicit credential needs a new choice. It cannot
  // silently move the next turn to another model or payer.
  if (choice.fallback === 'preference' && (keyChoice || selected)) throw new ActionFailureError('executionModelUnknown');
  if (choice.kind === "hosted") return { harness: "ai_sdk", model: COORDINATOR_MODEL };
  if (choice.kind === "apiKey")
    return {
      harness: "ai_sdk",
      model: choice.model,
      modelSelection: hostedApiKeySnapshotSchema.parse({
        ...(scope.botId === null ? { coordinator: true } : { consumerId: scope.botId }),
        type: "api_key", keyId: choice.key.id, ownerId: scope.ownerId, workspaceId, modelId: choice.model,
        ...(choice.key.revision !== undefined ? { credentialOwnerId: choice.key.ownerId, credentialRevision: choice.key.revision } : {}),
        ...(choice.key.organizationId ? { organizationId: choice.key.organizationId } : {}),
        ...(choice.fallback === "points" ? { afterPoints: true } : {}),
        ...(choice.quota ? { afterQuota: {
          subscription: choice.quota.subscription === "codex" ? "codex" : "claude",
          plan: choice.quota.plan,
          keyProvider: choice.key.provider,
          keyName: choice.key.name,
        } } : {}),
      }),
    };
  const bindingId = await settings.bindingForBot(settingsScope, scope.botId, choice.binding.bindingId);
  const frozen = await freezeHostedModelSelection(
    { ...scope, workspaceId },
    { harness: "ai_sdk", model: null },
    { type: "subscription", bindingId },
    dependencies,
  );
  return choice.fallback === "points" && frozen.modelSelection
    ? { ...frozen, modelSelection: { ...frozen.modelSelection, afterPoints: true } }
    : frozen;
}
