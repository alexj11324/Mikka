import { pgTable, text, uuid, integer, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core'
import type { AgentProfileDefinition, AgentProfileSkill } from '@/lib/factory/agent-profile-definition'
import type { ProfileColor, ProfileGlyph } from '@/lib/factory/agent-profile-mark'
export const factoryAgentProfiles = pgTable('factory_agent_profiles', {
  id: uuid('id').primaryKey(), ownerId: text('ownerId').notNull(), workspaceId: uuid('workspaceId').notNull(),
  version: integer('version').notNull(), definition: jsonb('definition').$type<AgentProfileDefinition>().notNull(),
  skills: jsonb('skills').$type<AgentProfileSkill[]>().notNull(), digest: text('digest').notNull(),
  // The Profile's mark (drizzle/20261110070000_agent_profile_marks.sql); null reads as the derived default.
  icon: text('icon').$type<ProfileGlyph>(), color: text('color').$type<ProfileColor>(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
}, table => [index('factory_agent_profiles_scope_idx').on(table.ownerId, table.workspaceId, table.createdAt, table.id)])
export const factoryAgentProfileVersions = pgTable('factory_agent_profile_versions', {
  profileId: uuid('profileId').notNull(), ownerId: text('ownerId').notNull(), workspaceId: uuid('workspaceId').notNull(),
  version: integer('version').notNull(), definition: jsonb('definition').$type<AgentProfileDefinition>().notNull(),
  skills: jsonb('skills').$type<AgentProfileSkill[]>().notNull(), digest: text('digest').notNull(),
  action: text('action').$type<'create' | 'update' | 'archive'>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.profileId, table.version] })])
