import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { existsSync,lstatSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { skillMarkdown,type SkillAssignmentReceipt } from '@mikka/protocol/skill'
import { RunContext } from '../../packages/daemon/src/agents/run-context'
import { verifyMountedSkill } from '../../packages/daemon/src/agents/skill-artifact'
import { BASELINE_ARTIFACT,BASELINE_SKILL } from './builtin-skill'

/** Executes the actual daemon Skill compilation with synthetic receipts only.
 * Uses a new private root and no helpers, harness homes, CLI, provider, network,
 * resetHandoff, supervisor, after/cleanup or existing-directory repair path. */
test('actual daemon compiles pinned baseline/candidate bytes into retained fresh run directories',()=>{
  const root=mkdtempSync(join(tmpdir(),'mikka-skill-compile-retained-'))
  assert.equal(lstatSync(root).mode&0o777,0o700)
  // Worktree is read only here: constructor performs git rev-parse only. All
  // writes use fresh children of the private mkdtemp root, never this repository.
  const worktree=resolve(fileURLToPath(new URL('../..',import.meta.url)))
  const candidate={...BASELINE_SKILL,instructions:'Synthetic candidate for actual compiler boundary; no quality claim.'}
  const candidateArtifact={...BASELINE_ARTIFACT,versionId:randomUUID(),sha256:createHash('sha256').update(skillMarkdown(candidate)).digest('hex')}
  const compiled:Record<string,string>[]=[]
  for(const [arm,skill,artifact] of [['baseline',BASELINE_SKILL,BASELINE_ARTIFACT],['candidate',candidate,candidateArtifact]] as const){
    const runDir=join(root,arm)
    assert.equal(existsSync(runDir),false,'Never repair, delete or rebuild an existing run directory')
    const receipt:SkillAssignmentReceipt={id:randomUUID(),runId:randomUUID(),issueId:randomUUID(),agentId:randomUUID(),
      repoId:randomUUID(),deviceId:randomUUID(),assignedAt:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60000).toISOString(),artifact}
    const context=new RunContext({harness:'codex',worktree,runDir,privateDir:root,skills:[skill],skillReceipt:receipt})
    const file=join(context.skillsDir,'run-report','SKILL.md')
    verifyMountedSkill(file,receipt)
    assert.equal(readFileSync(file,'utf8'),skillMarkdown(skill))
    assert.ok(context.instructions().includes(skill.instructions))
    assert.ok(file.startsWith(root+'/'));assert.ok(!file.startsWith(worktree+'/'))
    compiled.push({arm,path:file,versionId:artifact.versionId,sha256:artifact.sha256})
  }
  // One-way mutation of only this new synthetic candidate. Retain its failed
  // bytes and every directory for inspection; no reset or restoration follows.
  const candidateFile=compiled[1].path
  writeFileSync(candidateFile,'Synthetic tampered mounted bytes')
  assert.throws(()=>verifyMountedSkill(candidateFile,{artifact:candidateArtifact} as SkillAssignmentReceipt),/digest mismatch/)
  console.info(JSON.stringify({retainedRoot:root,compiled,receipts:'synthetic',realProviderCalls:0,actualHarnessDispatch:false,productionAcceptance:false}))
})
