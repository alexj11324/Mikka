/**
 * The models a Bot — and now a thread — may pin. Client-safe on purpose: the create dialog
 * needs the list to build its picker, and importing it from lib/db/schema would drag drizzle
 * into the browser bundle. Labels come from `BotModel.<value>` in the messages, never from here.
 */
export const WORKSPACE_BOT_MODELS = ['mikka', 'codex', 'claude'] as const
export type WorkspaceBotModel = (typeof WORKSPACE_BOT_MODELS)[number]
