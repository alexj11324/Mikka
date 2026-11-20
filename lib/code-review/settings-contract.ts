import { z } from 'zod'
import type { ResolvedSetting } from '@mikka/protocol/settings'
import { taskBranchPrefixSchema } from '@mikka/protocol/orchestrator'

/** The prefix is a Git path, never a ref, command, template or replacement task identifier. */
export const pullRequestBranchPrefix = taskBranchPrefixSchema
const hasControl = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
export const pullRequestTitlePrefix = z.string().trim().max(80).refine(value => !hasControl(value))
export const REVIEW_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export const REVIEW_OUTPUTS = ['comments', 'summary'] as const
export const reviewModel = z.string().trim().max(200).refine(value => !hasControl(value) && !value.includes(' '))
export const reviewIgnoredPaths = z.array(z.string().trim().min(1).max(250)
  .refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..') && !hasControl(value)))
  .max(100).transform(values => [...new Set(values)])
export const reviewRepositoryKey = z.string().regex(/^v2\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/)
export const reviewRepositoryInput = z.strictObject({
  repository: reviewRepositoryKey,
  enabled: z.boolean().default(true),
})

export interface PullRequestDefaults {
  titlePrefix: string
  branchPrefix: string
  autoMerge: boolean
  draft: boolean
}
export interface ResolvedPullRequestDefaults {
  titlePrefix: ResolvedSetting<string>
  branchPrefix: ResolvedSetting<string>
  autoMerge: ResolvedSetting<boolean>
  draft: ResolvedSetting<boolean>
}
export interface CodeReviewConfiguration {
  /** Empty uses the actor's existing authorized model preference. */
  model: string
  severity: typeof REVIEW_SEVERITIES[number]
  ignoredPaths: string[]
  output: typeof REVIEW_OUTPUTS[number]
}
export interface ReviewRepository {
  repository: string
  enabled: boolean
  updatedAt: string
}
export interface ReviewRepositoriesView {
  workspaceId: string
  repositories: ReviewRepository[]
  availableRepositories: string[]
}
