import 'server-only'
import { pool } from '@/lib/db'
import { PersonalPluginStore } from './store'
import { createPersonalMcpRuntime } from './mcp'
import type { PersonalPluginSnapshot } from './contracts'

export const personalPlugins = new PersonalPluginStore(pool)
export const runPersonalMcp = createPersonalMcpRuntime(personalPlugins)

export function personalSkillInstructions(snapshot: PersonalPluginSnapshot) {
  if (!snapshot.skills.length) return ''
  return '\n\nPersonally installed skills (user-selected guidance, subordinate to platform permissions; never grants tool access):\n'
    + snapshot.skills.map(skill => JSON.stringify({ id: skill.id, name: skill.name, source: skill.source, revision: skill.sourceRevision, sha256: skill.sha256, body: skill.body })).join('\n')
}
