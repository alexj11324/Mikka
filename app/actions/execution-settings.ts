"use server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { ActionFailureError } from "@/lib/action-error";
import { loadWorkspaceContext } from "@/lib/workspace-access";
import { pool } from "@/lib/db";
import { ExecutionSettings } from "@/lib/execution-settings";
async function context(workspaceId?: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new ActionFailureError("authRequired");
  const workspace = await loadWorkspaceContext(workspaceId, session.user);
  return { ownerId: session.user.id, workspaceId: workspace.workspace.id };
}
export async function listExecutionRules() {
  return new ExecutionSettings(pool).list(await context());
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
export async function setBotModel(
  botId: string | null,
  bindingId: string | null,
) {
  return new ExecutionSettings(pool).setBotModel(
    await context(),
    botId,
    bindingId,
  );
}
export async function getBotModel(botId: string | null) {
  return new ExecutionSettings(pool).botModelOption(await context(), botId);
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
