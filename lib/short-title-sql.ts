import { sql } from 'drizzle-orm'
import { issues } from '@/lib/db/schema'

/** A task's short title as a list reads it: only while the task still has the title it was written from. One column. */
export const issueShortTitle = sql<string | null>`case when ${issues.shortTitleFrom} = ${issues.title} then ${issues.shortTitle} end`
