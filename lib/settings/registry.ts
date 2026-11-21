import { z } from 'zod'
import type { ResolvedSetting, SettingSchemaEntry, SettingScope, SettingValue } from '@mikka/protocol/settings'
import { archiveIdleDays } from '@/lib/conversation-directory-input'
import { DEFAULT_TITLE_TRIGGERS, THREAD_TITLE_TRIGGERS, TITLE_INSTRUCTIONS_MAX } from '@/lib/thread-title'
import { settingMetadata } from './metadata'

export interface SettingDefinition extends SettingSchemaEntry {
  guard: z.ZodType<SettingValue>
  /** Existing account preferences stay global; title overrides belong to one workspace. */
  personalContext: 'account' | 'workspace'
}

const inherited = {
  scope: ['personal', 'workspace'] as SettingScope[], personalOverride: true,
  writeAccess: { personal: 'owner', workspace: 'admin' } as const,
}

/** Adding a scalar field here gives it validation, typed persistence, reset and schema search. */
export const SETTINGS_REGISTRY = {
  archiveIdleAfterDays: {
    ...inherited, key: 'archiveIdleAfterDays', group: 'threads', page: 'threads',
    ...settingMetadata('archiveIdleAfterDays'),
    type: 'integer', guard: z.literal(archiveIdleDays), defaultValue: 30, options: [...archiveIdleDays],
    personalContext: 'account',
  },
  threadTitleInstructions: {
    ...inherited, key: 'threadTitleInstructions', group: 'threads', page: 'threads',
    ...settingMetadata('threadTitleInstructions'),
    type: 'string', guard: z.string().trim().max(TITLE_INSTRUCTIONS_MAX), defaultValue: '',
    personalContext: 'workspace',
  },
  threadTitleTriggers: {
    ...inherited, key: 'threadTitleTriggers', group: 'threads', page: 'threads',
    ...settingMetadata('threadTitleTriggers'),
    type: 'string', guard: z.enum(THREAD_TITLE_TRIGGERS), defaultValue: DEFAULT_TITLE_TRIGGERS, options: [...THREAD_TITLE_TRIGGERS],
    personalContext: 'workspace',
  },
  subagentMaxConcurrent: {
    key: 'subagentMaxConcurrent', scope: ['workspace'], group: 'threads', page: 'threads',
    ...settingMetadata('subagentMaxConcurrent'),
    type: 'integer', guard: z.number().int().min(1).max(20), defaultValue: 6,
    personalOverride: false, writeAccess: { workspace: 'admin' }, personalContext: 'workspace',
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
  return Object.values(SETTINGS_REGISTRY).map(({ guard: _guard, personalContext: _context, ...entry }: SettingDefinition) => entry)
}
