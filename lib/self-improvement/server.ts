import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { createImprovementStore } from './store'
import { createSkillAssignments } from './assignments'
import { factoryStore, dispatchFactoryRun } from '../factory/server'
import { createImprovementFactoryBridge } from './factory-bridge'

const authorize: Parameters<typeof createSkillAssignments>[1] = async (userId, issueId, tx) =>
  Boolean(await issueForUser(userId, issueId, false, drizzle(tx)))
export const improvementStore = createImprovementStore(pool, authorize)
export const skillAssignments = createSkillAssignments(pool, authorize)
export const improvementFactory = createImprovementFactoryBridge(pool, factoryStore, dispatchFactoryRun, skillAssignments)
