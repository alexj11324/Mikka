import "server-only";
import { pool } from "./db";
import { ExecutionSettings, executionWorkspace } from "./execution-settings";
import { SubscriptionRefusal } from "@mikka/protocol/subscription";
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
  if (!binding) throw new SubscriptionRefusal("binding_required");
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
