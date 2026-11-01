"use server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { ActionFailureError } from "@/lib/action-error";
import { loadWorkspaceContext } from "@/lib/workspace-access";
import { pool } from "@/lib/db";
import { ExecutionSettings } from "@/lib/execution-settings";
import { botModelMenu, botModelScope, refreshBotModelMenu } from "@/lib/bot-model-menu";
import { z } from "zod";
import { chatBotId } from "@/lib/coordinator/coordinator-bot";
import { parseApiKeyOption } from "@/lib/bot-model-menu-view";
import { setBotApiKeyChoice } from "@/lib/model-api-keys";
import { WorkspaceError } from "@/lib/workspace-error";
async function context(workspaceId?: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new ActionFailureError("authRequired");
  const workspace = await loadWorkspaceContext(workspaceId, session.user);
  return { ownerId: session.user.id, workspaceId: workspace.workspace.id };
}
export async function listExecutionRules() {
  const scope = await context();
  try {
    return await new ExecutionSettings(pool).list(scope);
  } catch (error) {
    // A new account has no device or connected account to suggest a default from yet:
    // there are no rules to show, and the settings page fills in the initial choice.
    if (error instanceof ActionFailureError && error.code === "executionModelUnknown") return [];
    throw error;
  }
}
export async function createExecutionRule(
  value: Extract<
    Parameters<ExecutionSettings["mutate"]>[1],
    { kind: "save" }
  >["value"],
) {
  return new ExecutionSettings(pool).mutate(await context(), {
    kind: "save",
    value,
  });
}
export async function updateExecutionRule(
  id: string,
  value: Extract<
    Parameters<ExecutionSettings["mutate"]>[1],
    { kind: "save" }
  >["value"],
) {
  return new ExecutionSettings(pool).mutate(await context(), {
    kind: "save",
    id,
    value,
  });
}
export async function deleteExecutionRule(id: string) {
  return new ExecutionSettings(pool).mutate(await context(), {
    kind: "delete",
    id,
  });
}
export async function reorderExecutionRules(ids: string[]) {
  return new ExecutionSettings(pool).mutate(await context(), {
    kind: "reorder",
    ids,
  });
}
export async function listExecutionPlaces() {
  return new ExecutionSettings(pool).places(await context());
}
export async function redetectDevice(deviceId: string) {
  return new ExecutionSettings(pool).redetect(await context(), deviceId);
}
export async function listBotModels() {
  return new ExecutionSettings(pool).botModels(await context());
}
/** The chat's bot (no bot named: the person's Coordinator, an ordinary bot row) and the scope its picker reads and saves in. */
async function chatScope(chatBot: string | null) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new ActionFailureError("authRequired");
  if (chatBot !== null && !z.uuid().safeParse(chatBot).success) throw new ActionFailureError("botNotFound");
  const botId = await chatBotId(session.user.id, chatBot);
  return { botId, scope: await botModelScope(session.user.id, botId) };
}
/** The composer's model menu for a bot, or the Coordinator (`null`). */
export async function getBotModelMenu(chatBot: string | null) {
  const { botId, scope } = await chatScope(chatBot);
  return botModelMenu(pool, new ExecutionSettings(pool), scope, botId);
}
/** 刷新模型列表: re-reads what this person can use here, after asking each subscription for its models. */
export async function refreshBotModelMenuAction(chatBot: string | null) {
  const { botId, scope } = await chatScope(chatBot);
  return refreshBotModelMenu(pool, new ExecutionSettings(pool), scope, botId);
}
/**
 * Saves the composer's pick for the bot's next runs; a run already going keeps its model.
 * An API key model (`apikey:<keyId>:<model>`, C22) is saved as that key's choice.
 */
export async function chooseBotModel(chatBot: string | null, id: string) {
  const { botId, scope } = await chatScope(chatBot);
  const settings = new ExecutionSettings(pool);
  const apiKey = parseApiKeyOption(id);
  if (apiKey) {
    try {
      await setBotApiKeyChoice(pool, scope, botId, apiKey.keyId, apiKey.model);
    } catch (error) {
      if (error instanceof WorkspaceError) throw new ActionFailureError(error.code === "botNotFound" ? "botNotFound" : "executionModelUnknown");
      throw error;
    }
  } else await settings.setBotModel(scope, botId, id);
  return botModelMenu(pool, settings, scope, botId);
}

export async function listWorkspaceIssueLabels(workspaceId?: string) {
  return new ExecutionSettings(pool).labels(await context(workspaceId));
}
export async function refreshBotModels(connectionId: string, workspaceId?: string) {
  return new ExecutionSettings(pool).refreshBotModels(await context(workspaceId), connectionId);
}
export async function getRedetectDeviceStatus(commandId: string, workspaceId?: string) {
  return new ExecutionSettings(pool).redetectStatus(await context(workspaceId), commandId);
}

export async function getExecutionFallbacks() {
  return new ExecutionSettings(pool).fallbacks((await context()).ownerId);
}
export async function updateExecutionFallbacks(
  value: import("@/lib/execution-rules").ExecutionFallbacks,
) {
  return new ExecutionSettings(pool).setFallbacks(
    (await context()).ownerId,
    value,
  );
}
