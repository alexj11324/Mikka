import { createHash } from 'node:crypto'
import { skillMarkdown, type RunSkill, type SkillArtifactRef } from '@mikka/protocol/skill'
import { BASELINE } from './regression'

// One app-owned baseline only. This is neither a marketplace nor a candidate
// activation API. Changing bytes requires a new immutable version identity.
export const BASELINE_SKILL: RunSkill = Object.freeze({
  id: '64377d3f-f2dc-4577-8a28-d73696523f01', name: 'Run report', description: null,
  instructions: BASELINE.trim(), files: [],
})
export const BASELINE_MARKDOWN = skillMarkdown(BASELINE_SKILL)
export const BASELINE_ARTIFACT: SkillArtifactRef = Object.freeze({
  schemaVersion: 1, registryId: 'mikka-builtin', skillId: BASELINE_SKILL.id,
  versionId: 'aa39c8af-e44c-4f38-bbc6-55e075f78701', format: 'single-skill-md-v1',
  sha256: createHash('sha256').update(BASELINE_MARKDOWN, 'utf8').digest('hex'),
})
