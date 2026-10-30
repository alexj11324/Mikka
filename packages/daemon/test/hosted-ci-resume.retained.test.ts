import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RunAssignment } from '@mikka/protocol'
import { createHostedBotRunner } from '../src/subscription-hosted-runner'
import { MemoryServer } from '../src/server-link'
import { createLogger } from '../src/log'
import { buildChildEnv } from '../src/env'
import { ToolApprovalGate } from '../src/agents/tool-approval'

for (const harness of ['codex','claude_code'] as const) it(`restores ${harness} on a different retained hosted runner`, async () => {
  const root = mkdtempSync(join(tmpdir(),'mikka-hosted-ci-retained-'))
  const repo = join(root,'repo'); mkdirSync(repo)
  const git = (...args:string[]) => execFileSync('git',args,{cwd:repo,env:{...process.env,GIT_AUTHOR_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic',GIT_COMMITTER_EMAIL:'synthetic@example.invalid'}})
  git('init','-q','-b','main'); writeFileSync(join(repo,'README.md'),'synthetic'); git('add','README.md'); git('commit','-qm','fixture')
  const deviceId=randomUUID(), origin=randomUUID(), child=randomUUID(), bindingId=randomUUID(), workspaceId=randomUUID(), consumerId=randomUUID()
  let saved: Buffer | undefined
  const link = Object.assign(new MemoryServer(deviceId).link(), {
    nativeContext: async () => ({ route: harness === 'codex' ? 'codex_cli' as const : 'claude_code_cli' as const,modelId:'fixture-model',revision:2,accountId:'fixture-account',expiresAt:new Date(Date.now()+60000).toISOString() }),
    nativeRequest: async () => { throw new Error('fixture must not call provider') },
    nativeSaveSession: async (_device:string,_run:string,_session:string,data:Buffer) => { saved=Buffer.from(data) },
    nativeRestoreSession: async () => { if (!saved) throw new Error('missing snapshot'); return saved },
  })
  const binary=resolve(import.meta.dirname,`fakes/fake-${harness === 'codex' ? 'codex' : 'claude'}-subscription.mjs`)
  const assignment = {runId:origin,deviceId,issueId:randomUUID(),repoId:randomUUID(),baseBranch:'main',harness,prompt:'hello',model:'fixture-model',subscriptionBinding:{bindingId,ownerId:'fixture-owner',workspaceId,consumerId,route:harness === 'codex' ? 'codex_cli' : 'claude_code_cli'}} as RunAssignment
  const options = (runId:string) => ({runId,toolApproval:new ToolApprovalGate(runId,{permission:()=> 'deny',ask:async()=> 'deny',isLive:()=>true}),cwd:repo,prompt:'hello',model:'fixture-model',env:buildChildEnv({host:{PATH:process.env.PATH,HOME:root}}),log:createLogger({level:'silent' as const})})
  const first=await createHostedBotRunner({stateDir:join(root,'first'),link,binaries:{[harness]:binary},retainResources:true})
  const original=await first.start(assignment,options(origin))
  const firstEvents=[]; for await(const e of original.events()) firstEvents.push(e)
  expect(firstEvents.at(-1)).toMatchObject({type:'exit',outcome:'succeeded'})
  expect(saved).toBeDefined()
  const second=await createHostedBotRunner({stateDir:join(root,'second'),link,binaries:{[harness]:binary},retainResources:true})
  const next={...assignment,runId:child,continuesRunId:origin,resumeSessionId:original.sessionId,requireSessionResume:true,ciSessionResume:true} as RunAssignment
  const resumed=await second.start(next,{...options(child),requireSessionResume:true,continueSession:{runId:origin,sessionId:original.sessionId,message:'CI finished'}})
  expect(resumed.sessionId).toBe(original.sessionId)
  const events=[]; for await(const e of resumed.events()) events.push(e)
  expect(events.at(-1)).toMatchObject({type:'exit',outcome:'succeeded'})
},60000)
