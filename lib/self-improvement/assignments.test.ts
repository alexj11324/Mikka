import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { skillMarkdown, skillSlug, type SkillAssignmentReceipt } from '@mikka/protocol/skill'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN, BASELINE_SKILL } from './builtin-skill'
import { verifyAssignedSkills, verifySkillAssignment, verifyMountedSkill, verifySkillResume } from '../../packages/daemon/src/agents/skill-artifact'
import { RunContext } from '../../packages/daemon/src/agents/run-context'
import { RunSupervisor, type SupervisorDeps } from '../../packages/daemon/src/runs/supervisor'
import { RunJournal } from '../../packages/daemon/src/runs/journal'

export function fixtureReceipt():SkillAssignmentReceipt {
  return {id:randomUUID(),runId:randomUUID(),issueId:randomUUID(),agentId:randomUUID(),repoId:randomUUID(),
    deviceId:randomUUID(),leaseExpiresAt:new Date(Date.now()+60000).toISOString(),assignedAt:new Date().toISOString(),artifact:BASELINE_ARTIFACT}
}
test('daemon validates assignment bindings and actual bytes without trusting a model report',()=>{
  const receipt=fixtureReceipt()
  const assignment={runId:receipt.runId,issueId:receipt.issueId,deviceId:receipt.deviceId,repoId:receipt.repoId,
    baseBranch:'main',harness:'codex' as const,prompt:'synthetic',leaseExpiresAt:receipt.leaseExpiresAt,skills:[BASELINE_SKILL],skillReceipt:receipt}
  verifySkillAssignment(assignment)
  assert.throws(()=>verifySkillAssignment({...assignment,runId:randomUUID()}),/binding/)
  assert.throws(()=>verifySkillAssignment({...assignment,repoId:randomUUID()}),/binding/)
  assert.throws(()=>verifySkillAssignment({...assignment,leaseExpiresAt:new Date().toISOString()}),/binding/)
  assert.throws(()=>verifyAssignedSkills([{...BASELINE_SKILL,instructions:'injected'}],receipt),/digest/)
  assert.throws(()=>verifyAssignedSkills([{...BASELINE_SKILL,files:[{path:'file',content:'extra'}]}],receipt),/digest/)
  assert.throws(()=>verifyAssignedSkills([],receipt),/digest/)
  assert.equal(verifySkillResume(assignment,{skillReceipt:receipt,leaseExpiresAt:receipt.leaseExpiresAt}),receipt.leaseExpiresAt)
  assert.throws(()=>verifySkillResume(assignment,{skillReceipt:receipt,leaseExpiresAt:new Date(0).toISOString()}),/authorization/)
  assert.throws(()=>verifySkillResume(assignment,{skillReceipt:{...receipt,id:randomUUID()},leaseExpiresAt:receipt.leaseExpiresAt}),/authorization/)
})
test('real RunContext mounts the pinned Skill; tampering and symlink redirection fail',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mikka-skill-mount-')), worktree=join(root,'worktree')
  await mkdir(worktree)
  execFileSync('git',['init','--quiet',worktree])
  const receipt=fixtureReceipt(), runDir=join(root,'run')
  const options={harness:'codex' as const,worktree,runDir,privateDir:join(root,'private'),skills:[BASELINE_SKILL],skillReceipt:receipt}
  const context=new RunContext(options)
  const file=join(context.skillsDir,skillSlug(BASELINE_SKILL.name),'SKILL.md')
  assert.equal(await readFile(file,'utf8'),BASELINE_MARKDOWN)
  assert.equal(skillMarkdown(BASELINE_SKILL),BASELINE_MARKDOWN)
  verifyMountedSkill(file,receipt)
  await writeFile(file,'tampered')
  assert.throws(()=>verifyMountedSkill(file,receipt),/digest/)
  const redirected=join(root,'redirected'),outside=join(root,'outside')
  await mkdir(join(redirected,'skills'),{recursive:true});await mkdir(outside)
  await writeFile(join(outside,'SKILL.md'),'sentinel')
  await symlink(outside,join(redirected,'skills',skillSlug(BASELINE_SKILL.name)))
  assert.throws(()=>new RunContext({...options,runDir:redirected}),/Unsafe Skill artifact directory/)
  assert.equal(await readFile(join(outside,'SKILL.md'),'utf8'),'sentinel')
  const hardlinked=join(root,'hardlinked'),hardDir=join(hardlinked,'skills',skillSlug(BASELINE_SKILL.name))
  await mkdir(hardDir,{recursive:true});await link(join(outside,'SKILL.md'),join(hardDir,'SKILL.md'))
  assert.throws(()=>new RunContext({...options,runDir:hardlinked}),/Unsafe Skill artifact file/)
  assert.equal(await readFile(join(outside,'SKILL.md'),'utf8'),'sentinel')
  // Synthetic fixtures retained; no data deletion or external/model call.
})
test('receipted journal resume cannot launch an adapter while online validation is unavailable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mikka-skill-resume-')),receipt=fixtureReceipt()
  const assignment={runId:receipt.runId,issueId:receipt.issueId,deviceId:receipt.deviceId,repoId:receipt.repoId,
    baseBranch:'main',harness:'codex' as const,prompt:'fixture',leaseExpiresAt:receipt.leaseExpiresAt,skills:[BASELINE_SKILL],skillReceipt:receipt}
  const journal=new RunJournal(join(root,'journal.json'))
  journal.put({assignment,state:'running',sessionId:'synthetic',worktree:root,lastSeq:0,error:null,updatedAt:new Date().toISOString()})
  let touched=0
  const deps={journal,outbox:{lastChunkSeq:()=>0},repos:()=>[{repoId:receipt.repoId,name:'fixture',path:root}],
    adapters:new Map(),worktrees:{create:()=>{touched++;throw new Error('must not launch')}},log:{}} as unknown as SupervisorDeps
  const supervisor=new RunSupervisor(deps)
  await supervisor.resumeAll()
  assert.equal(touched,0);assert.deepEqual(supervisor.activeRunIds(),[])
  assert.match(journal.get(receipt.runId)!.error!,/current online/)
  const offline=new RunSupervisor({...deps,revalidateSkillAssignment:async()=>{throw new Error('offline')}})
  await offline.resumeAll();assert.equal(touched,0);assert.deepEqual(offline.activeRunIds(),[])
})
