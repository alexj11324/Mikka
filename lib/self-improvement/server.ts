import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { createImprovementStore } from './store'
import { createSkillAssignments } from './assignments'
import { factoryStore, dispatchFactoryRun } from '../factory/server'
import { createImprovementFactoryBridge } from './factory-bridge'
import { invokeDecision } from '../coordinator/decide'
import { createRegisteredSkillEvaluator } from './registered-evaluation'
import { createSkillComparisonCollector } from './comparison-collector'
import { getArtifactObject } from '../artifacts/storage'

const authorize: Parameters<typeof createSkillAssignments>[1] = async (userId, issueId, tx) =>
  Boolean(await issueForUser(userId, issueId, false, drizzle(tx)))
// Read #316's existing frozen case/run/mount/version records and existing
// artifact storage, with current issue authorization. No parallel registry or
// Factory stage reader is introduced. Model evaluation is explicitly OFF for
// this task; valid collection is still observable as decision_model_disabled.
export const loadSkillComparison=createSkillComparisonCollector(pool,
  async(userId,issueId)=>Boolean(await issueForUser(userId,issueId,false)),getArtifactObject)
export const skillEffectEvaluator=createRegisteredSkillEvaluator({loadComparison:loadSkillComparison,invokeDecision,modelEvaluationEnabled:false})
const evaluate=skillEffectEvaluator
export const improvementStore = createImprovementStore(pool, authorize, evaluate)
export const skillAssignments = createSkillAssignments(pool, authorize)
export const improvementFactory = createImprovementFactoryBridge(pool, factoryStore, dispatchFactoryRun, skillAssignments, evaluate)
