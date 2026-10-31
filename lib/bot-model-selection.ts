import "server-only";
import { pool } from "./db";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { COORDINATOR_MODEL } from "./coordinator/model";
import {
  freezeHostedModelSelection,
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
  const settingsScope = { ownerId: scope.ownerId, workspaceId };
  const selected = await settings.botModel(settingsScope, scope.botId);
  const available = await settings.botModels(settingsScope);
  // A saved choice whose account was disconnected or signed in again is no longer bound:
  // take a bound subscription (Claude first), otherwise Mikka Cloud (decision 2026-10-31-2110).
  const binding =
    (selected ? await settings.botBinding(settingsScope, selected) : undefined) ??
    available.find((row) => row.provider === "claude") ??
    available[0];
  // No subscription bound: every bot, the Coordinator included, runs on the hosted default
  // through the same admission (verified card, allowance) and workspace billing.
  if (!binding) return { harness: "ai_sdk", model: COORDINATOR_MODEL };
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
