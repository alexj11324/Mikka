'use server'

// A person's own list state that follows them across devices: pinned pull requests and saved views
// (drizzle/20261120045013). Reads and writes stay inside the workspace the caller names and belongs to.
import { z } from 'zod'
import { headers } from '@/lib/server-runtime/headers'
import { auth } from '@/lib/auth'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { savedViewScopes, saveViewInput, type SaveViewInput, type SavedView, type SavedViewScope } from '@/lib/saved-views'

async function member(workspaceId: unknown) {
  const parsed = z.uuid().safeParse(workspaceId)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(parsed.data, session.user)
  if (context.workspace.id !== parsed.data) throw new ActionFailureError('workspaceAccessDenied')
  const { pool } = await import('@/lib/db')
  return { userId: session.user.id, workspaceId: parsed.data, pool }
}

/** The person's pinned PRs here, as githubPullRequestKey values. */
export async function listPullPins(workspaceId: string): Promise<string[]> {
  const { userId, pool } = await member(workspaceId)
  return (await import('@/lib/pull-pins')).listPullPins(pool, userId, workspaceId)
}

/** Pins (or unpins) PRs by URL and returns the pins after the change. */
export async function setPullPins(workspaceId: string, urls: string[], pinned: boolean): Promise<ActionResult<{ pins: string[] }, 'pullPinLimit' | 'validationGeneric'>> {
  const { userId, pool } = await member(workspaceId)
  const pins = await import('@/lib/pull-pins')
  const input = pins.pullPinsInput.safeParse({ workspaceId, urls, pinned })
  if (!input.success) return { error: 'validationGeneric' }
  const result = await pins.setPullPins(pool, userId, input.data)
  return result === 'pinLimit' ? { error: 'pullPinLimit' } : { pins: result }
}

/** The person's saved views of one list here, oldest first. */
export async function listSavedViews(workspaceId: string, scope: SavedViewScope): Promise<SavedView[]> {
  const { userId, pool } = await member(workspaceId)
  if (!savedViewScopes.includes(scope)) throw new ActionFailureError('validationGeneric')
  return (await import('@/lib/saved-views-store')).listSavedViews(pool, userId, workspaceId, scope)
}

/** Saves a view under its name; the same name replaces that view's filters. */
export async function saveView(input: SaveViewInput): Promise<ActionResult<{ view: SavedView }, 'savedViewLimit' | 'validationGeneric'>> {
  const parsed = saveViewInput.safeParse(input)
  if (!parsed.success) return { error: 'validationGeneric' }
  const { userId, pool } = await member(parsed.data.workspaceId)
  const view = await (await import('@/lib/saved-views-store')).saveView(pool, userId, parsed.data)
  return view ? { view } : { error: 'savedViewLimit' }
}

export async function deleteSavedView(workspaceId: string, id: string): Promise<ActionResult<{ deleted: true }, 'savedViewNotFound' | 'validationGeneric'>> {
  const { userId, pool } = await member(workspaceId)
  if (!z.uuid().safeParse(id).success) return { error: 'validationGeneric' }
  return await (await import('@/lib/saved-views-store')).deleteSavedView(pool, userId, workspaceId, id)
    ? { deleted: true } : { error: 'savedViewNotFound' }
}
