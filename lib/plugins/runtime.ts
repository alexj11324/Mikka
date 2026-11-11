import 'server-only'
import { pool } from '@/lib/db'
import { PersonalPluginStore } from './store'
import { createPersonalMcpRuntime } from './mcp'
import type { PersonalPluginSnapshot } from './contracts'
import { WorkspaceMcpStore } from './workspace-mcp'
import { coordinatorSkillSection } from './skill-prompt'

export const personalPlugins = new PersonalPluginStore(pool)
export const runPersonalMcp = createPersonalMcpRuntime(personalPlugins)
export const workspaceMcp = new WorkspaceMcpStore(pool)

/** The skills section of the Coordinator's prompt for one round. With
 * `read_personal_skill` in the round's frozen grant the section is metadata
 * only and bodies are fetched on demand; without it the section keeps
 * ALE-72's inline budget. See ./skill-prompt.ts for why the two shapes exist. */
export function personalSkillInstructions(snapshot: PersonalPluginSnapshot, canReadBody = false) {
  return coordinatorSkillSection(snapshot.skills, canReadBody)
}
