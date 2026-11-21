import 'server-only'
import type { SettingScope, SettingValue } from '@mikka/protocol/settings'
import type { db } from '@/lib/db'
import { threadTitleSettings, userPreferences } from '@/lib/db/schema'
import { archivePreferenceChanged } from '@/lib/live/lists'
import { SETTINGS_REGISTRY, type SettingKey } from './registry'
import type { SettingsContext } from './store'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Mirror = (tx: Transaction, scope: SettingScope, context: SettingsContext, value: SettingValue | null) => Promise<void>
type TitleChange = Pick<typeof threadTitleSettings.$inferInsert, 'instructions' | 'triggers'>

async function mirrorTitle(tx: Transaction, scope: SettingScope, context: SettingsContext, change: TitleChange) {
  await tx.insert(threadTitleSettings).values({ workspaceId: context.workspaceId, userId: scope === 'workspace' ? '' : context.userId, ...change })
    .onConflictDoUpdate({ target: [threadTitleSettings.workspaceId, threadTitleSettings.userId], set: { ...change, updatedAt: new Date() } })
}

const mirrors = {
  async archiveIdleAfterDays(tx, scope, { userId }, value) {
    if (scope !== 'personal') return
    const field = SETTINGS_REGISTRY.archiveIdleAfterDays
    const archiveIdleAfterDays = field.guard.parse(value ?? field.defaultValue)
    await tx.insert(userPreferences).values({ userId, archiveIdleAfterDays })
      .onConflictDoUpdate({ target: userPreferences.userId, set: { archiveIdleAfterDays, updatedAt: new Date() } })
    await archivePreferenceChanged(tx, userId)
  },
  async threadTitleInstructions(tx, scope, context, value) {
    const field = SETTINGS_REGISTRY.threadTitleInstructions
    await mirrorTitle(tx, scope, context, { instructions: field.guard.parse(value ?? field.defaultValue) })
  },
  async threadTitleTriggers(tx, scope, context, value) {
    const field = SETTINGS_REGISTRY.threadTitleTriggers
    const triggers = value === null && scope === 'personal' ? null : field.guard.parse(value ?? field.defaultValue)
    await mirrorTitle(tx, scope, context, { triggers })
  },
} satisfies Partial<Record<SettingKey, Mirror>>

export function mirrorLegacySetting(key: string): Mirror | undefined {
  return Object.hasOwn(mirrors, key) ? mirrors[key as keyof typeof mirrors] : undefined
}
