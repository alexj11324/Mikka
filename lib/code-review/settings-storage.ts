import 'server-only'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { SettingScope, SettingValue } from '@mikka/protocol/settings'
import { db } from '@/lib/db'
import type { SettingsContext } from '@/lib/settings/store'
import { resolveSettingValue } from '@/lib/settings/registry'
import type { PullRequestDefaults, CodeReviewConfiguration } from './settings-contract'
import { pullRequestDefaults, workspaceCodeReviewConfiguration } from './settings-schema'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>

/** Called only after the registry's field guard and current scope authority. */
export async function mirrorCodeReviewSetting(tx: Transaction, scope: SettingScope, context: SettingsContext, key: string, value: SettingValue | null) {
  const updatedAt = new Date()
  if (key.startsWith('pr')) {
    const column = { prTitlePrefix: 'titlePrefix', prBranchPrefix: 'branchPrefix', prAutoMerge: 'autoMerge', prDraft: 'draft' }[key]
    if (!column) throw new Error('Unknown pull request setting')
    const change = { [column]: value, updatedAt }
    await tx.insert(pullRequestDefaults).values({ workspaceId: context.workspaceId, userId: scope === 'personal' ? context.userId : null, ...change })
      .onConflictDoUpdate({ target: [pullRequestDefaults.workspaceId, pullRequestDefaults.userId], set: change })
  } else {
    const column = { codeReviewModel: 'model', codeReviewSeverity: 'severity', codeReviewIgnoredPaths: 'ignoredPaths', codeReviewOutput: 'output' }[key]
    if (!column || scope !== 'workspace') throw new Error('Unknown code review setting')
    const change = { [column]: value, updatedAt }
    await tx.insert(workspaceCodeReviewConfiguration).values({ workspaceId: context.workspaceId, ...change })
      .onConflictDoUpdate({ target: workspaceCodeReviewConfiguration.workspaceId, set: change })
  }
}

/** Internal execution callers already hold the task/run's workspace authority. */
export async function publicationDefaults(context: { userId: string; workspaceId: string | null }, database: Reader = db): Promise<PullRequestDefaults> {
  const rows = context.workspaceId ? await database.select().from(pullRequestDefaults).where(and(eq(pullRequestDefaults.workspaceId, context.workspaceId),
    or(isNull(pullRequestDefaults.userId), eq(pullRequestDefaults.userId, context.userId)))) : []
  const own = rows.find(row => row.userId === context.userId), workspace = rows.find(row => row.userId === null)
  return {
    titlePrefix: resolveSettingValue('prTitlePrefix', own?.titlePrefix, workspace?.titlePrefix).value as string,
    branchPrefix: resolveSettingValue('prBranchPrefix', own?.branchPrefix, workspace?.branchPrefix).value as string,
    autoMerge: resolveSettingValue('prAutoMerge', own?.autoMerge, workspace?.autoMerge).value as boolean,
    draft: resolveSettingValue('prDraft', own?.draft, workspace?.draft).value as boolean,
  }
}

export async function codeReviewConfiguration(workspaceId: string, database: Reader = db): Promise<CodeReviewConfiguration> {
  const [row] = await database.select().from(workspaceCodeReviewConfiguration).where(and(eq(workspaceCodeReviewConfiguration.workspaceId, workspaceId)))
  return {
    model: resolveSettingValue('codeReviewModel', null, row?.model).value as string,
    severity: resolveSettingValue('codeReviewSeverity', null, row?.severity).value as CodeReviewConfiguration['severity'],
    ignoredPaths: resolveSettingValue('codeReviewIgnoredPaths', null, row?.ignoredPaths).value as string[],
    output: resolveSettingValue('codeReviewOutput', null, row?.output).value as CodeReviewConfiguration['output'],
  }
}
