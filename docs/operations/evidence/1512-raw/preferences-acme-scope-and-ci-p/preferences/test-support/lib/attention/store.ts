import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { attentionSettings } from '@/lib/db/schema'
export async function attentionEnabled(userId: string, executor: Pick<typeof db, 'select'> = db): Promise<boolean> {
  const [row] = await executor.select({ enabled: attentionSettings.enabled }).from(attentionSettings).where(eq(attentionSettings.userId, userId)).limit(1)
  return row?.enabled ?? true
}
export async function setAttentionEnabled(): Promise<void> { throw new Error('unused_fixture_write') }
