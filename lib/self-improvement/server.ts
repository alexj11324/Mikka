import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { createImprovementStore } from './store'
import { createSkillAssignments } from './assignments'
import { factoryStore, dispatchFactoryRun } from '../factory/server'
import { createImprovementFactoryBridge } from './factory-bridge'
import { invokeDecision } from '../coordinator/decide'
import { createImprovementEvaluator } from './evaluation'

const authorize: Parameters<typeof createSkillAssignments>[1] = async (userId, issueId, tx) =>
  Boolean(await issueForUser(userId, issueId, false, drizzle(tx)))
// #331's existing budgeted vision-capable route. Until a trusted fixed-task
// comparison collector is integrated, evaluation stays pending and invokes no
// provider. Reports/feedback and caller image URLs cannot stand in for one.
const evaluate = createImprovementEvaluator({ invokeDecision })
export const improvementStore = createImprovementStore(pool, authorize, evaluate)
export const skillAssignments = createSkillAssignments(pool, authorize)
export const improvementFactory = createImprovementFactoryBridge(pool, factoryStore, dispatchFactoryRun, skillAssignments, evaluate)
