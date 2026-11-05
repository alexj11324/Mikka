import { digest, skillDefinitionSchema } from '@/lib/agent-kit/definition'
import { AgentProfileError, type AgentProfileSkill } from './agent-profile-definition'

/** Reviewed, instruction-only capabilities. References cannot mount arbitrary files,
 * fetch URLs, run hooks, grant tools, or change the host's permission policy. */
const definitions = [
  {
    id: 'implementation-evidence', name: 'Implementation evidence', description: 'Tie changes and verification evidence to the task acceptance criteria.', version: 1,
    content: 'Read the task acceptance criteria before changing code. Keep the change within the authorized repository and scope. Verify the affected behavior with the existing project checks and actual observable results. Record which criteria passed, what commands or checks ran, and which criteria remain unverified with the concrete reason. Never claim a test ran from a suggested command or a prior run. Preserve the task candidate and source revision in the final report. Do not merge or publish unless the host supplied the required human authorization.',
  },
  {
    id: 'independent-review', name: 'Independent review', description: 'Review the frozen candidate independently and report actionable findings.', version: 1,
    content: 'Review the exact candidate and acceptance criteria supplied by the host. Independently inspect the relevant changes, behavior, and verification evidence; do not treat the implementer summary as proof. Check authorization boundaries, regressions, data integrity, and failure handling in proportion to the change. Report concrete findings with affected files and reproducible evidence, or state what was checked when no actionable finding remains. Identify missing evidence explicitly. Honor the task review limit and leave acceptance and merge to the human approval flow.',
  },
  {
    id: 'systematic-debugging', name: 'Systematic debugging', description: 'Reproduce a failure and verify the smallest justified root-cause fix.', version: 1,
    content: 'Start from the observed failure and expected behavior. Reproduce it in the authorized environment, inspect the evidence, and state a testable root-cause hypothesis. Change the smallest responsible boundary, then repeat the failing check and relevant regression checks. Separate observations from inferences. Stop speculative changes when evidence is missing and report the exact blocker. Never weaken authorization, substitute fake success, or expose credentials in debugging output.',
  },
] as const
const catalog: readonly AgentProfileSkill[] = definitions.map(skill => {
  // Reuse AgentKit's exact instruction-only Skill schema. Profiles add only the
  // immutable version/content envelope consumed by the existing native worker.
  const parsed = skillDefinitionSchema.parse({ id: skill.id, name: skill.name, description: skill.description, body: skill.content })
  const validated = { id: parsed.id, name: parsed.name, description: parsed.description, version: skill.version, content: parsed.body }
  return { ...validated, digest: digest(validated) }
})
export function agentProfileSkillsCatalog() { return catalog.map(({ content: _content, ...skill }) => skill) }
export function resolveAgentProfileSkills(ids: readonly string[]): AgentProfileSkill[] {
  return ids.map(id => {
    const skill = catalog.find(item => item.id === id)
    if (!skill) throw new AgentProfileError('agentProfileSkillUnavailable', 400)
    return { ...skill }
  })
}
