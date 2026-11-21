import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/lib/db/schema'

const valueColumns = () => ({
  key: text('key').notNull(),
  booleanValue: boolean('booleanValue'), integerValue: integer('integerValue'),
  textValue: text('textValue'), textArrayValue: text('textArrayValue').array(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** At most one typed value; all null is an explicit reset to inheritance. */
export const personalSettingValues = pgTable('personal_setting_values', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspaceId'), ...valueColumns(),
}, table => [
  unique('personal_setting_values_scope_key').on(table.userId, table.workspaceId, table.key).nullsNotDistinct(),
  check('personal_setting_values_one_type', sql`num_nonnulls(${table.booleanValue}, ${table.integerValue}, ${table.textValue}, ${table.textArrayValue}) <= 1`),
])

export const workspaceSettingValues = pgTable('workspace_setting_values', {
  workspaceId: uuid('workspaceId').notNull(), ...valueColumns(),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.key] }),
  check('workspace_setting_values_one_type', sql`num_nonnulls(${table.booleanValue}, ${table.integerValue}, ${table.textValue}, ${table.textArrayValue}) <= 1`),
])
