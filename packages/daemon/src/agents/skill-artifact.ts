import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { skillMarkdown, type RunSkill, type SkillAssignmentReceipt } from '@mikka/protocol/skill'
import type { RunAssignment } from '@mikka/protocol/device'
import { skillAssignmentReceiptSchema, type SkillReceiptRevalidation } from '@mikka/protocol/skill'

export function verifyAssignedSkills(skills: readonly RunSkill[] | undefined, receipt: SkillAssignmentReceipt | undefined) {
  if (!receipt) return // Legacy non-receipted skills remain explicitly unproven.
  if (skills?.length !== 1 || skills[0].id !== receipt.artifact.skillId || skills[0].files.length !== 0 ||
    createHash('sha256').update(skillMarkdown(skills[0]), 'utf8').digest('hex') !== receipt.artifact.sha256)
    throw new Error('Assigned Skill artifact digest mismatch')
}
export function verifySkillAssignment(assignment: RunAssignment) {
  const receipt = assignment.skillReceipt
  if (!receipt) return
  if (receipt.runId !== assignment.runId || receipt.issueId !== assignment.issueId || receipt.repoId !== assignment.repoId ||
    receipt.deviceId !== assignment.deviceId || receipt.leaseExpiresAt !== assignment.leaseExpiresAt)
    throw new Error('Skill assignment receipt binding mismatch')
  verifyAssignedSkills(assignment.skills, receipt)
}
export function verifyMountedSkill(file: string, receipt: SkillAssignmentReceipt) {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).nlink!==1 ||
    createHash('sha256').update(readFileSync(file)).digest('hex') !== receipt.artifact.sha256)
    throw new Error('Mounted Skill artifact digest mismatch')
}
export function verifySkillResume(assignment:RunAssignment,current:SkillReceiptRevalidation) {
  if (!assignment.skillReceipt||JSON.stringify(skillAssignmentReceiptSchema.parse(assignment.skillReceipt))!==JSON.stringify(skillAssignmentReceiptSchema.parse(current.skillReceipt))||
    Date.parse(current.leaseExpiresAt)<=Date.now()) throw new Error('Skill resume requires current server authorization')
  verifySkillAssignment(assignment)
  return current.leaseExpiresAt
}
