'use server'

import { headers } from '@/lib/server-runtime/headers'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import {
  dismissSetupChecklist as dismissChecklist, restoreSetupChecklist as restoreChecklist, finishOnboarding, readOnboardingProgress, resetOnboardingForUser,
  saveOnboardingProgress, setupChecklistDismissed,
} from '@/lib/onboarding'
import { startingProgress, type OnboardingProgress } from '@/lib/onboarding-steps'
import { SETUP_ITEMS, type SetupChecklist } from '@/lib/setup-checklist'

async function sessionUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user
}

/** The person finished or skipped the first-run guide; it does not come back. */
export async function completeOnboarding() {
  await finishOnboarding((await sessionUser()).id)
}

export async function resetOnboarding() {
  await resetOnboardingForUser((await sessionUser()).id)
}

/**
 * Where the guide opens in this workspace: the saved place, else the start.
 * Someone who joined another person's team workspace starts at 模型.
 */
export async function onboardingStart(workspaceId?: string): Promise<{ progress: OnboardingProgress; invitee: boolean }> {
  const user = await sessionUser()
  const { loadWorkspaceContext } = await import('@/lib/workspace-access')
  const { workspacePool } = await import('@/lib/workspace-db')
  const context = await loadWorkspaceContext(workspaceId)
  let invitee = false
  if (context.workspace.kind === 'team') {
    const { rows: [row] } = await workspacePool.query<{ userId: string }>('SELECT "userId" FROM mikka_workspaces WHERE id=$1', [context.workspace.id])
    invitee = Boolean(row) && row.userId !== user.id
  }
  return { progress: startingProgress(await readOnboardingProgress(user.id), invitee), invitee }
}

/** Saves the guide's place, so a refresh or another device resumes it. */
export async function saveOnboardingStep(progress: OnboardingProgress): Promise<OnboardingProgress> {
  return saveOnboardingProgress((await sessionUser()).id, progress)
}

/**
 * The setup checklist on 新建任务: each item's state is read from what exists
 * (a task, a subscription or key, a computer, an app, a teammate), never stored.
 */
export async function setupChecklist(workspaceId: string): Promise<SetupChecklist> {
  const user = await sessionUser()
  const [{ loadWorkspaceContext }, { workspacePool }, { pool }] = await Promise.all([import('@/lib/workspace-access'), import('@/lib/workspace-db'), import('@/lib/db')])
  const context = await loadWorkspaceContext(workspaceId)
  const id = context.workspace.id
  const team = context.workspace.kind === 'team'
  if (await setupChecklistDismissed(user.id, id)) return { dismissed: true, team, done: {} }
  const { rows: [own] } = await pool.query<{ task: boolean; model: boolean; device: boolean; app: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM issues WHERE "userId"=$1 AND "workspaceId"=$2) AS task,
      (EXISTS (SELECT 1 FROM byos_connections WHERE "ownerId"=$1 AND "removedAt" IS NULL)
        OR EXISTS (SELECT 1 FROM model_api_keys WHERE "ownerId"=$1)) AS model,
      EXISTS (SELECT 1 FROM devices WHERE "ownerId"=$1 AND kind='local') AS device,
      EXISTS (SELECT 1 FROM composio_accounts WHERE "userId"=$1) AS app`, [user.id, id])
  let invite = false
  if (team) {
    const { rows: [row] } = await workspacePool.query<{ invite: boolean }>(`SELECT
        (SELECT count(*) FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status='active') > 1
        OR EXISTS (SELECT 1 FROM mikka_workspace_invitations WHERE "workspaceId"=$1 AND status <> 'revoked') AS invite`, [id])
    invite = Boolean(row?.invite)
  }
  const done = { task: own.task, model: own.model, device: own.device, app: own.app, invite }
  return { dismissed: false, team, done: Object.fromEntries(SETUP_ITEMS.filter(item => done[item]).map(item => [item, true])) }
}

export async function dismissSetupChecklist(workspaceId: string) {
  const user = await sessionUser()
  const { loadWorkspaceContext } = await import('@/lib/workspace-access')
  const context = await loadWorkspaceContext(workspaceId, user)
  await dismissChecklist(user.id, context.workspace.id)
}

export async function restoreSetupChecklist(workspaceId: string) {
  const user = await sessionUser()
  const { loadWorkspaceContext } = await import('@/lib/workspace-access')
  const context = await loadWorkspaceContext(workspaceId, user)
  await restoreChecklist(user.id, context.workspace.id)
}
