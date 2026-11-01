import { sql } from 'drizzle-orm'
import { devices } from '@/lib/db/schema'

/**
 * A thread machine's device is a task's own cloud sandbox, not one of the
 * person's machines (Alex, 2026-11-01: 「回收之后就不应该再显示出来，根本不应该被派发，
 * 应该直接消失掉。」). Lists of machines leave it out while it lives, too.
 */
export const notThreadMachineDevice = sql`NOT EXISTS (SELECT 1 FROM thread_machines tm WHERE tm."deviceId" = ${devices.id})`
