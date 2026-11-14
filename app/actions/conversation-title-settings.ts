'use server'

import { z } from 'zod'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { conversationTitleSettings } from '@/lib/db/schema'
import { ActionFailureError } from '@/lib/action-error'
import { CONVERSATION_TITLE_TRIGGERS, DEFAULT_TITLE_TRIGGERS, TITLE_INSTRUCTIONS_MAX, type ConversationTitleTriggers } from '@/lib/conversation-title'
import { workspaceRole } from '@/lib/secrets/store'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

export type ConversationTitleSettingsView = {
  /** The workspace's instructions and triggers (Capy's organization settings). */
  workspace: { instructions: string; triggers: ConversationTitleTriggers }
  /** The person's own instructions, and their triggers or null for the workspace's (Capy's "Org default"). */
  mine: { instructions: string; triggers: ConversationTitleTriggers | null }
  /** Only an admin edits the workspace's settings. */
  admin: boolean
}

/** Capy's "Thread titles": what this person and their workspace have set for naming conversations. */
export async function getConversationTitleSettings(workspaceId?: string): Promise<SettingsActionResult<ConversationTitleSettingsView>> {
  return settingsWorkspaceAction(async () => readSettings(await currentWorkspaceActor(workspaceId)))
}

async function readSettings(actor: Awaited<ReturnType<typeof currentWorkspaceActor>>): Promise<ConversationTitleSettingsView> {
  const rows = await db.select().from(conversationTitleSettings)
    .where(and(eq(conversationTitleSettings.workspaceId, actor.workspaceId), inArray(conversationTitleSettings.userId, ['', actor.userId])))
  const workspace = rows.find(row => row.userId === '')
  const mine = rows.find(row => row.userId === actor.userId)
  return {
    workspace: { instructions: workspace?.instructions ?? '', triggers: workspace?.triggers ?? DEFAULT_TITLE_TRIGGERS },
    mine: { instructions: mine?.instructions ?? '', triggers: mine?.triggers ?? null },
    admin: actor.role === 'admin',
  }
}

const input = z.object({
  workspaceId: z.string().optional(),
  scope: z.enum(['workspace', 'mine']),
  instructions: z.string().max(TITLE_INSTRUCTIONS_MAX).optional(),
  triggers: z.enum(CONVERSATION_TITLE_TRIGGERS as [ConversationTitleTriggers, ...ConversationTitleTriggers[]]).nullable().optional(),
})

/**
 * Saves one field of the workspace's or the person's settings. The workspace's need an admin, checked again at the
 * write; the workspace always has triggers, so only a person's can go back to the default (null).
 */
export async function saveConversationTitleSettings(raw: z.input<typeof input>): Promise<SettingsActionResult<ConversationTitleSettingsView>> {
  return settingsWorkspaceAction(async () => {
    const parsed = input.parse(raw)
    const actor = await currentWorkspaceActor(parsed.workspaceId)
    const userId = parsed.scope === 'workspace' ? '' : actor.userId
    if (parsed.scope === 'workspace' && await workspaceRole(actor.userId, actor.workspaceId) !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
    if (parsed.scope === 'workspace' && parsed.triggers === null) throw new ActionFailureError('validationGeneric')
    const change = {
      ...parsed.instructions !== undefined ? { instructions: parsed.instructions.trim() } : {},
      ...parsed.triggers !== undefined ? { triggers: parsed.triggers } : {},
    }
    await db.insert(conversationTitleSettings).values({ workspaceId: actor.workspaceId, userId, ...change })
      .onConflictDoUpdate({ target: [conversationTitleSettings.workspaceId, conversationTitleSettings.userId], set: { ...change, updatedAt: new Date() } })
    return readSettings(actor)
  })
}
