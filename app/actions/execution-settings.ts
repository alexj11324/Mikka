"use server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { ActionFailureError } from "@/lib/action-error";
import { loadWorkspaceContext } from "@/lib/workspace-access";
import { pool } from "@/lib/db";
import { ExecutionSettings } from "@/lib/execution-settings";
import { botModelMenu, botModelScope, refreshBotModelMenu } from "@/lib/bot-model-menu";
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
async function chatScope(botId: string | null) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new ActionFailureError("authRequired");
  return botModelScope(session.user.id, botId);
}
/** The composer's model menu for a bot, or the Coordinator (`null`). */
export async function getBotModelMenu(botId: string | null) {
  const scope = await chatScope(botId);
  return botModelMenu(pool, new ExecutionSettings(pool), scope, botId);
}
/** 刷新模型列表: re-reads what this person can use here, after asking each subscription for its models. */
export async function refreshBotModelMenuAction(botId: string | null) {
  const scope = await chatScope(botId);
  return refreshBotModelMenu(pool, new ExecutionSettings(pool), scope, botId);
}
/** Saves the composer's pick for the bot's next runs; a run already going keeps its model. */
export async function chooseBotModel(botId: string | null, id: string) {
  const scope = await chatScope(botId);
  const settings = new ExecutionSettings(pool);
  await settings.setBotModel(scope, botId, id);
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
