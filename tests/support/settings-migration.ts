import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

export async function applySettingsMigration(pool: Pick<Pool, 'query'>) {
  await pool.query(`CREATE TABLE user_preferences ("userId" text, "archiveIdleAfterDays" integer);
    CREATE TABLE thread_title_settings ("userId" text, "workspaceId" uuid, instructions text, triggers text)`)
  await pool.query(await readFile(new URL('../../drizzle/20261120185516_typed_setting_values.sql', import.meta.url), 'utf8'))
}
