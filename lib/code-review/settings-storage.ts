import 'server-only'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { SettingScope, SettingValue } from '@mikka/protocol/settings'
import type { db } from '@/lib/db'
import type { SettingsContext } from '@/lib/settings/store'
import { resolveSettingValue, type ReviewSettingMirror } from '@/lib/settings/registry'
import type { PullRequestDefaults, CodeReviewConfiguration } from './settings-contract'
import { pullRequestDefaults, workspaceCodeReviewConfiguration } from './settings-schema'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

/** Called only after the registry's field guard and current scope authority. */
export async function mirrorCodeReviewSetting(tx: Transaction, scope: SettingScope, context: SettingsContext, mirror: ReviewSettingMirror, value: SettingValue | null) {
  const change = { [mirror.column]: value, updatedAt: new Date() }
  if (mirror.table === 'pull-request') {
    await tx.insert(pullRequestDefaults).values({ workspaceId: context.workspaceId, userId: scope === 'personal' ? context.userId : null, ...change })
      .onConflictDoUpdate({ target: [pullRequestDefaults.workspaceId, pullRequestDefaults.userId], set: change })
  } else {
    if (scope !== 'workspace') throw new Error('Unknown code review setting')
    await tx.insert(workspaceCodeReviewConfiguration).values({ workspaceId: context.workspaceId, ...change })
      .onConflictDoUpdate({ target: workspaceCodeReviewConfiguration.workspaceId, set: change })
  }
}

/** Internal execution callers already hold the task/run's workspace authority. */
export async function publicationDefaults(context: { userId: string; workspaceId: string | null }, database?: Reader): Promise<PullRequestDefaults> {
  const rows = context.workspaceId ? await (database ?? (await import('@/lib/db')).db).select().from(pullRequestDefaults).where(and(eq(pullRequestDefaults.workspaceId, context.workspaceId),
    or(isNull(pullRequestDefaults.userId), eq(pullRequestDefaults.userId, context.userId)))) : []
  const own = rows.find(row => row.userId === context.userId), workspace = rows.find(row => row.userId === null)
  return {
    titlePrefix: resolveSettingValue('prTitlePrefix', own?.titlePrefix, workspace?.titlePrefix).value as string,
    branchPrefix: resolveSettingValue('prBranchPrefix', own?.branchPrefix, workspace?.branchPrefix).value as string,
    autoMerge: resolveSettingValue('prAutoMerge', own?.autoMerge, workspace?.autoMerge).value as boolean,
    draft: resolveSettingValue('prDraft', own?.draft, workspace?.draft).value as boolean,
  }
}

export async function codeReviewConfiguration(workspaceId: string, database?: Reader): Promise<CodeReviewConfiguration> {
  const [row] = await (database ?? (await import('@/lib/db')).db).select().from(workspaceCodeReviewConfiguration).where(and(eq(workspaceCodeReviewConfiguration.workspaceId, workspaceId)))
  return {
    model: resolveSettingValue('codeReviewModel', null, row?.model).value as string,
    severity: resolveSettingValue('codeReviewSeverity', null, row?.severity).value as CodeReviewConfiguration['severity'],
    ignoredPaths: resolveSettingValue('codeReviewIgnoredPaths', null, row?.ignoredPaths).value as string[],
    output: resolveSettingValue('codeReviewOutput', null, row?.output).value as CodeReviewConfiguration['output'],
  }
}
