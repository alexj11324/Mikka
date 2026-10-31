import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

/** What a team admin can switch off for members' personal items in one workspace (decision 2026-10-31-2130). */
export const PERSONAL_RESOURCES = ['subscriptions', 'apps', 'devices'] as const
export type PersonalResource = (typeof PERSONAL_RESOURCES)[number]
export type PersonalPolicy = Record<PersonalResource, boolean>
export const personalPolicyInput = z.strictObject({ resource: z.enum(PERSONAL_RESOURCES), allowed: z.boolean() })

type Query = Pick<Pool | PoolClient, 'query'>

/** All on unless an admin switched one off; an absent row means all on. */
export async function readPersonalPolicy(query: Query, workspaceId: string): Promise<PersonalPolicy> {
  const { rows: [row] } = await query.query<PersonalPolicy>('SELECT subscriptions,apps,devices FROM workspace_personal_policies WHERE "workspaceId"=$1', [workspaceId])
  return { subscriptions: row?.subscriptions ?? true, apps: row?.apps ?? true, devices: row?.devices ?? true }
}

export async function personalResourceAllowed(query: Query, workspaceId: string, resource: PersonalResource): Promise<boolean> {
  return (await readPersonalPolicy(query, workspaceId))[resource]
}
