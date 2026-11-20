import 'server-only'
import type { db } from '@/lib/db'
import { settingDefinition } from './registry'
import { personalSettingValues } from './schema'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The authenticated preferences action already holds its user lock and transaction.
 * Keep this small writer statically linked: preferences also runs inside Eve's single authored module. */
export async function writePersonalArchiveSetting(tx: Transaction, userId: string, raw: unknown): Promise<void> {
  const field = settingDefinition('archiveIdleAfterDays')
  const changed = { booleanValue: null, integerValue: field.guard.parse(raw) as number, textValue: null, textArrayValue: null, updatedAt: new Date() }
  await tx.insert(personalSettingValues).values({ userId, workspaceId: null, key: field.key, ...changed })
    .onConflictDoUpdate({ target: [personalSettingValues.userId, personalSettingValues.workspaceId, personalSettingValues.key], set: changed })
}
