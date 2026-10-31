import "server-only";
import { pool } from "./db";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { SubscriptionRefusal } from "@mikka/protocol/subscription";
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
  const binding = selected
    ? await settings.botBinding(settingsScope, selected)
    : available[0];
  if (!binding) {
    // Nothing chosen and no subscription: every bot, the Coordinator included, runs on the hosted default
    // through the same admission (verified card, allowance) and workspace billing. A missing chosen binding refuses.
    if (!selected) return { harness: "ai_sdk", model: COORDINATOR_MODEL };
    throw new SubscriptionRefusal("binding_required");
  }
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
