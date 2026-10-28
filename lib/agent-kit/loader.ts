import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { MAX_DEFINITION_BYTES, parseDefinition, type AgentDefinition } from './definition'

/** Developer/build-time loader only. The HTTP importer never resolves paths or executes code. */
export async function loadAgentDirectory(directory: string): Promise<AgentDefinition> {
  const root = await realpath(directory)
  async function text(path: unknown) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(segment => !segment || segment === '..' || segment === '.')) throw new Error('agentAssetPathInvalid')
    const full = resolve(root,path)
    const file = await lstat(full)
    const actual = await realpath(full)
    const rel = relative(root,actual)
    if (file.isSymbolicLink() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !file.isFile() || file.size > MAX_DEFINITION_BYTES) throw new Error('agentAssetPathInvalid')
    return readFile(actual,'utf8')
  }
  const manifest = JSON.parse(await text('agent.json')) as Record<string, unknown>
  const { instructionsFile, ...materialized } = manifest
  if (instructionsFile !== undefined) {
    if ('instructions' in materialized) throw new Error('agentInstructionsAmbiguous')
    materialized.instructions = await text(instructionsFile)
  }
  if (Array.isArray(materialized.skills)) {
    materialized.skills = await Promise.all(materialized.skills.map(async input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('agentSkillInvalid')
      const { bodyFile, ...skill } = input as Record<string, unknown>
      if (bodyFile !== undefined) {
        if ('body' in skill) throw new Error('agentSkillBodyAmbiguous')
        skill.body = await text(bodyFile)
      }
      return skill
    }))
  }
  return parseDefinition(materialized)
}
