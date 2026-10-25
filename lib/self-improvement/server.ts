import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { createImprovementStore } from './store'

export const improvementStore = createImprovementStore(pool, async (userId, issueId, tx) =>
  Boolean(await issueForUser(userId, issueId, false, drizzle(tx))))
