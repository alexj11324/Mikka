import { z } from 'zod'
import type { ResolvedSetting, SettingSchemaEntry, SettingScope, SettingValue } from '@mikka/protocol/settings'
import { archiveIdleDays } from '@/lib/conversation-directory-input'
import { DEFAULT_TITLE_TRIGGERS, THREAD_TITLE_TRIGGERS, TITLE_INSTRUCTIONS_MAX } from '@/lib/thread-title'
import { pullRequestBranchPrefix, pullRequestTitlePrefix, reviewIgnoredPaths, reviewModel, REVIEW_OUTPUTS, REVIEW_SEVERITIES } from '@/lib/code-review/settings-contract'

export interface SettingDefinition extends SettingSchemaEntry {
  guard: z.ZodType<SettingValue>
  /** Existing account preferences stay global; title overrides belong to one workspace. */
  personalContext: 'account' | 'workspace'
  legacy?: 'archive-days' | 'title-instructions' | 'title-triggers'
  storage?: 'pull-request' | 'code-review'
}

const inherited = {
  scope: ['personal', 'workspace'] as SettingScope[], personalOverride: true,
  writeAccess: { personal: 'owner', workspace: 'admin' } as const,
}

/** Adding a scalar field here gives it validation, typed persistence, reset and schema search. */
export const SETTINGS_REGISTRY = {
  archiveIdleAfterDays: {
    ...inherited, key: 'archiveIdleAfterDays', group: 'threads', page: 'threads',
    label: { en: 'Archive idle threads', 'zh-CN': '归档闲置线程' }, keywords: ['archive', 'idle', 'days', '归档', '闲置'],
    type: 'integer', guard: z.literal(archiveIdleDays), defaultValue: 30, options: [...archiveIdleDays],
    personalContext: 'account', legacy: 'archive-days',
  },
  threadTitleInstructions: {
    ...inherited, key: 'threadTitleInstructions', group: 'threads', page: 'threads',
    label: { en: 'Thread title instructions', 'zh-CN': '线程标题指令' }, keywords: ['title', 'naming', '标题', '指令'],
    type: 'string', guard: z.string().trim().max(TITLE_INSTRUCTIONS_MAX), defaultValue: '',
    personalContext: 'workspace', legacy: 'title-instructions',
  },
  threadTitleTriggers: {
    ...inherited, key: 'threadTitleTriggers', group: 'threads', page: 'threads',
    label: { en: 'Update thread titles', 'zh-CN': '更新线程标题' }, keywords: ['title', 'pull request', 'PR', '标题', '拉取请求'],
    type: 'string', guard: z.enum(THREAD_TITLE_TRIGGERS), defaultValue: DEFAULT_TITLE_TRIGGERS, options: [...THREAD_TITLE_TRIGGERS],
    personalContext: 'workspace', legacy: 'title-triggers',
  },
  subagentMaxConcurrent: {
    key: 'subagentMaxConcurrent', scope: ['workspace'], group: 'threads', page: 'threads',
    label: { en: 'Concurrent subagents', 'zh-CN': '并发子 Agent 数量' }, keywords: ['agent', 'concurrency', 'limit', '子 Agent', '并发', '限制'],
    type: 'integer', guard: z.number().int().min(1).max(20), defaultValue: 6,
    personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace',
  },
  prTitlePrefix: {
    ...inherited, key: 'prTitlePrefix', group: 'git', page: 'git',
    label: { en: 'Pull request title prefix', 'zh-CN': 'PR 标题前缀' }, keywords: ['git', 'PR', 'title', 'prefix', '标题', '前缀'],
    type: 'string', guard: pullRequestTitlePrefix, defaultValue: '', personalContext: 'workspace', storage: 'pull-request',
  },
  prBranchPrefix: {
    ...inherited, key: 'prBranchPrefix', group: 'git', page: 'git',
    label: { en: 'Branch prefix', 'zh-CN': '分支前缀' }, keywords: ['git', 'branch', 'prefix', '分支', '前缀'],
    type: 'string', guard: pullRequestBranchPrefix, defaultValue: 'mikka', personalContext: 'workspace', storage: 'pull-request',
  },
  prAutoMerge: {
    ...inherited, key: 'prAutoMerge', group: 'git', page: 'git',
    label: { en: 'Automatically merge verified pull requests', 'zh-CN': '自动合并已验证的 PR' }, keywords: ['git', 'PR', 'auto', 'merge', '自动', '合并'],
    type: 'boolean', guard: z.boolean(), defaultValue: false, personalContext: 'workspace', storage: 'pull-request',
  },
  prDraft: {
    ...inherited, key: 'prDraft', group: 'git', page: 'git',
    label: { en: 'Open pull requests as drafts', 'zh-CN': '以草稿创建 PR' }, keywords: ['git', 'PR', 'draft', '草稿'],
    type: 'boolean', guard: z.boolean(), defaultValue: false, personalContext: 'workspace', storage: 'pull-request',
  },
  codeReviewModel: {
    key: 'codeReviewModel', scope: ['workspace'], group: 'code-review', page: 'review',
    label: { en: 'Code review model', 'zh-CN': '代码审阅模型' }, keywords: ['review', 'model', 'agent', '审阅', '模型'],
    type: 'string', guard: reviewModel, defaultValue: '', personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace', storage: 'code-review',
  },
  codeReviewSeverity: {
    key: 'codeReviewSeverity', scope: ['workspace'], group: 'code-review', page: 'review',
    label: { en: 'Code review severity', 'zh-CN': '代码审阅严重度' }, keywords: ['review', 'severity', 'threshold', '审阅', '严重度', '阈值'],
    type: 'string', guard: z.enum(REVIEW_SEVERITIES), defaultValue: 'medium', options: [...REVIEW_SEVERITIES], personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace', storage: 'code-review',
  },
  codeReviewIgnoredPaths: {
    key: 'codeReviewIgnoredPaths', scope: ['workspace'], group: 'code-review', page: 'review',
    label: { en: 'Code review ignored paths', 'zh-CN': '代码审阅忽略路径' }, keywords: ['review', 'ignore', 'paths', '审阅', '忽略', '路径'],
    type: 'string-array', guard: reviewIgnoredPaths, defaultValue: [], personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace', storage: 'code-review',
  },
  codeReviewOutput: {
    key: 'codeReviewOutput', scope: ['workspace'], group: 'code-review', page: 'review',
    label: { en: 'Code review output', 'zh-CN': '代码审阅输出' }, keywords: ['review', 'comment', 'summary', '审阅', '评论', '汇总'],
    type: 'string', guard: z.enum(REVIEW_OUTPUTS), defaultValue: 'comments', options: [...REVIEW_OUTPUTS], personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace', storage: 'code-review',
  },
} satisfies Record<string, SettingDefinition>

export type SettingKey = keyof typeof SETTINGS_REGISTRY

export function settingDefinition(key: string): SettingDefinition {
  if (!Object.hasOwn(SETTINGS_REGISTRY, key)) throw new z.ZodError([{ code: 'custom', path: [key], message: 'Unknown setting' }])
  return SETTINGS_REGISTRY[key as SettingKey]
}

export const settingsPatchInput = z.strictObject({ values: z.record(z.string().min(1).max(120), z.unknown()) })
export const settingsResetInput = z.strictObject({ group: z.string().min(1).max(100) })

/** Re-parse with each field's own guard even when a typed client already validated its input. */
export function parseSettingsPatch(scope: SettingScope, raw: unknown): Record<string, SettingValue | null> {
  const { values } = settingsPatchInput.parse(raw)
  if (!Object.keys(values).length || Object.keys(values).length > 100) throw new z.ZodError([{ code: 'custom', path: ['values'], message: 'Empty or oversized settings patch' }])
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const field = settingDefinition(key)
    if (!field.writeAccess[scope] || !field.scope.includes(scope) || (scope === 'personal' && !field.personalOverride)) {
      throw new z.ZodError([{ code: 'custom', path: ['values', key], message: 'Setting cannot be written in this scope' }])
    }
    return [key, value === null ? null : field.guard.parse(value)]
  }))
}

/** Null alone means inherit; false, zero and empty strings remain explicit overrides. */
export function resolveSettingValue(key: string, personal: SettingValue | null | undefined, workspace: SettingValue | null | undefined): ResolvedSetting {
  const field = settingDefinition(key)
  if (field.personalOverride && field.scope.includes('personal') && personal != null) return { value: field.guard.parse(personal), source: 'personal' }
  if (field.scope.includes('workspace') && workspace != null) return { value: field.guard.parse(workspace), source: 'workspace' }
  return { value: field.guard.parse(field.defaultValue), source: 'default' }
}

export function settingsSchema(): SettingSchemaEntry[] {
  return Object.values(SETTINGS_REGISTRY).map(({ guard: _guard, personalContext: _context, legacy: _legacy, storage: _storage, ...entry }: SettingDefinition) => entry)
}
