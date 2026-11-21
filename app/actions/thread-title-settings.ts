'use server'

import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { threadTitleSettings } from '@/lib/db/schema'
import { writeSettings } from '@/lib/settings/store'
import { THREAD_TITLE_TRIGGERS, DEFAULT_TITLE_TRIGGERS, TITLE_INSTRUCTIONS_MAX, type ThreadTitleTriggers } from '@/lib/thread-title'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

export type ThreadTitleSettingsView = {
  /** The workspace's instructions and triggers (Capy's organization settings). */
  workspace: { instructions: string; triggers: ThreadTitleTriggers }
  /** The person's own instructions, and their triggers or null for the workspace's (Capy's "Org default"). */
  mine: { instructions: string; triggers: ThreadTitleTriggers | null }
  /** Only an admin edits the workspace's settings. */
  admin: boolean
}

/** Capy's "Thread titles": what this person and their workspace have set for naming threads. */
export async function getThreadTitleSettings(workspaceId?: string): Promise<SettingsActionResult<ThreadTitleSettingsView>> {
  return settingsWorkspaceAction(async () => readSettings(await currentWorkspaceActor(workspaceId)))
}

async function readSettings(actor: Awaited<ReturnType<typeof currentWorkspaceActor>>): Promise<ThreadTitleSettingsView> {
  const rows = await db.select().from(threadTitleSettings)
    .where(and(eq(threadTitleSettings.workspaceId, actor.workspaceId), inArray(threadTitleSettings.userId, ['', actor.userId])))
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
  triggers: z.enum(THREAD_TITLE_TRIGGERS as [ThreadTitleTriggers, ...ThreadTitleTriggers[]]).nullable().optional(),
})

/**
 * Saves one field of the workspace's or the person's settings. The workspace's need an admin, checked again at the
 * write; the workspace always has triggers, so only a person's can go back to the default (null).
 */
export async function saveThreadTitleSettings(raw: z.input<typeof input>): Promise<SettingsActionResult<ThreadTitleSettingsView>> {
  return settingsWorkspaceAction(async () => {
    const parsed = input.parse(raw)
    const actor = await currentWorkspaceActor(parsed.workspaceId)
    if (parsed.scope === 'workspace' && parsed.triggers === null) throw new ActionFailureError('validationGeneric')
    const values = {
      ...(parsed.instructions !== undefined ? { threadTitleInstructions: parsed.instructions } : {}),
      ...(parsed.triggers !== undefined ? { threadTitleTriggers: parsed.triggers } : {}),
    }
    await writeSettings(actor, parsed.scope === 'workspace' ? 'workspace' : 'personal', { values })
    return readSettings(actor)
  })
}
