"use server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { ActionFailureError, runAction } from "@/lib/action-error";
import type { ActionResult } from "@/lib/action-result";
import type { BotModelMenu } from "@/lib/bot-model-menu-view";
import { loadWorkspaceContext } from "@/lib/workspace-access";
import { pool } from "@/lib/db";
import { ExecutionSettings } from "@/lib/execution-settings";
import { botModelMenu, botModelScope, chooseBotModel as chooseBotModelFor, refreshBotModelMenu } from "@/lib/bot-model-menu";
import { z } from "zod";
import { chatBotId } from "@/lib/coordinator/coordinator-bot";
async function context(workspaceId?: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new ActionFailureError("authRequired");
  const workspace = await loadWorkspaceContext(workspaceId, session.user);
  return { ownerId: session.user.id, workspaceId: workspace.workspace.id };
}
export async function listBotModels() {
  return new ExecutionSettings(pool).botModels(await context());
}
/** The chat's bot (no bot named: the person's Coordinator, an ordinary bot row) and the scope its picker reads and saves in. */
async function chatScope(chatBot: string | null) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new ActionFailureError("authRequired");
  if (chatBot !== null && !z.uuid().safeParse(chatBot).success) throw new ActionFailureError("botNotFound");
  // No bot named: the Coordinator of the workspace the person has open.
  const botId = chatBot ?? await chatBotId(session.user.id, null, (await loadWorkspaceContext(undefined, session.user)).workspace.id);
  return { botId, scope: await botModelScope(session.user.id, botId) };
}
/** The composer's model menu for a bot, or the Coordinator (`null`). */
export async function getBotModelMenu(chatBot: string | null) {
  const { botId, scope } = await chatScope(chatBot);
  const settings = new ExecutionSettings(pool);
  // The chat menu also upgrades optional Codex Fast metadata; ordinary dispatch keeps valid legacy catalogues.
  await settings.ensureCatalogues(scope, undefined, undefined, { codexPriority: true });
  return botModelMenu(pool, settings, scope, botId);
}
/** 刷新模型列表: re-reads what this person can use here, after asking each subscription for its models. */
export async function refreshBotModelMenuAction(chatBot: string | null) {
  const { botId, scope } = await chatScope(chatBot);
  return refreshBotModelMenu(pool, new ExecutionSettings(pool), scope, botId);
}
/**
 * Saves the composer's pick for the bot's next runs; a run already going keeps its model.
 * An API key model (`apikey:<keyId>:<model>`, C22) is saved as that key's choice.
 * A pick that cannot be saved (the account went away, the bot is gone) is an expected
 * error, returned as `{ error }` rather than thrown, so the request does not answer 500.
 */
export async function chooseBotModel(chatBot: string | null, id: string): Promise<ActionResult<BotModelMenu>> {
  return runAction(async () => {
    const { botId, scope } = await chatScope(chatBot);
    return chooseBotModelFor(pool, new ExecutionSettings(pool), scope, botId, id);
  });
}

export async function refreshBotModels(connectionId: string, workspaceId?: string) {
  return new ExecutionSettings(pool).refreshBotModels(await context(workspaceId), connectionId);
}
