import 'server-only'
import { pool } from '@/lib/db'
import { PersonalPluginStore } from './store'
import { createPersonalMcpRuntime } from './mcp'
import type { PersonalPluginSnapshot } from './contracts'
import { WorkspaceMcpStore } from './workspace-mcp'
import { coordinatorSkillInstructions } from './skill-prompt'

export const personalPlugins = new PersonalPluginStore(pool)
export const runPersonalMcp = createPersonalMcpRuntime(personalPlugins)
export const workspaceMcp = new WorkspaceMcpStore(pool)

/** The skills section of the Coordinator's prompt. Bounded by
 * `COORDINATOR_SKILL_BUDGET_CHARS`; see ./skill-prompt.ts for why that is a
 * constant of its own rather than ALE-42's task-thread budget. */
export function personalSkillInstructions(snapshot: PersonalPluginSnapshot) {
  return coordinatorSkillInstructions(snapshot.skills)
}
