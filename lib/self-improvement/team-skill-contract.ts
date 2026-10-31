import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runSkillSchema, skillDescriptionSchema, skillInstructionsSchema, skillMarkdown, skillNameSchema,
  type RunSkill, type SkillArtifactRef } from '@mikka/protocol/skill'
import { ImprovementError } from './contract'

const singleLine = (value: string) => !/[\r\n\0]/.test(value)
export const teamSkillUploadSchema = z.strictObject({
  skillId: z.uuid().optional(),
  name: skillNameSchema.refine(singleLine),
  description: skillDescriptionSchema.refine(singleLine).nullable().default(null),
  instructions: skillInstructionsSchema.refine(value => !value.includes('\0')),
  source: z.literal('workspace-upload'),
  license: z.string().max(100).regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/),
  format: z.literal('single-skill-md-v1'),
  // This first format contains guidance only. It installs no packages or grants.
  dependencies: z.tuple([]),
  permissions: z.tuple([]),
})
export const teamSkillManifestSchema = teamSkillUploadSchema.pick({ format: true, dependencies: true, permissions: true })
export interface TeamSkillMetadata {
  versionId: string; workspaceId: string; skillId: string; catalogOwnerId: string
  submittedBy: string; name: string; description: string | null; license: string
  manifest: { format: 'single-skill-md-v1'; dependencies: []; permissions: [] }
  source: 'workspace-upload'; createdAt: Date
}
export function teamSkillArtifact(versionId: string, skillId: string, markdown: string): SkillArtifactRef {
  return { schemaVersion: 1, registryId: 'mikka-team', skillId, versionId, format: 'single-skill-md-v1',
    sha256: createHash('sha256').update(markdown, 'utf8').digest('hex') }
}
export function resolveTeamSkillContent(metadata: Pick<TeamSkillMetadata,'skillId'|'name'|'description'>,
  artifact: SkillArtifactRef, markdown: string): RunSkill {
  const marker='__mikka_team_body__'
  const prefix=skillMarkdown({name:metadata.name,description:metadata.description,instructions:marker}).slice(0,-marker.length-1)
  if (artifact.registryId!=='mikka-team' || artifact.skillId!==metadata.skillId || !markdown.startsWith(prefix) ||
    Buffer.byteLength(markdown)>100_000 || markdown.includes('\0') ||
    new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(markdown,'utf8'))!==markdown ||
    createHash('sha256').update(markdown,'utf8').digest('hex')!==artifact.sha256) throw new ImprovementError('sourceMismatch')
  const parsed=runSkillSchema.safeParse({id:metadata.skillId,name:metadata.name,description:metadata.description,
    instructions:markdown.slice(prefix.length).trim(),files:[]})
  if(!parsed.success || skillMarkdown(parsed.data)!==markdown)throw new ImprovementError('sourceMismatch')
  return parsed.data
}
