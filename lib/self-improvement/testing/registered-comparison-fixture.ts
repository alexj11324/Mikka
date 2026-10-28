import { createHash,randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { skillMarkdown,type SkillAssignmentReceipt } from '@mikka/protocol/skill'
import { BASELINE_ARTIFACT,BASELINE_MARKDOWN,BASELINE_SKILL } from '../builtin-skill'
import { SKILL_PATH } from '../regression'
import { REPORT_BENCHMARK,buildTask,freezeBenchmarkInstance } from '../report-benchmark'

const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
/** All identities, outputs and documents are synthetic. This is not a
 * collector, real execution, real evaluation or approval receipt. */
export function registeredComparisonFixture(){
  const userId='synthetic-owner',issueId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),deviceId=randomUUID(),proposalId=randomUUID(),evaluationId=randomUUID(),instanceId=randomUUID(),taskId=randomUUID(),candidateId=randomUUID()
  const sourceCommit='a'.repeat(40),candidateCommitSha='b'.repeat(40),seed='1'.repeat(64),instance=freezeBenchmarkInstance(seed)
  const startedAt=new Date(Date.now()-4000).toISOString(),assignedAt=new Date(Date.now()-3500).toISOString(),mountedAt=new Date(Date.now()-3000).toISOString(),recordedAt=new Date(Date.now()-2000).toISOString(),finishedAt=new Date(Date.now()-1000).toISOString()
  const markdown=skillMarkdown({...BASELINE_SKILL,instructions:'Synthetic registered candidate; no claim of real improvement.'})
  const candidateArtifact={...BASELINE_ARTIFACT,versionId:randomUUID(),sha256:hash(markdown)}
  const receipt=(runId:string,artifact=BASELINE_ARTIFACT):SkillAssignmentReceipt=>({id:randomUUID(),runId,issueId,agentId,repoId,deviceId,assignedAt,leaseExpiresAt:new Date(Date.now()+30000).toISOString(),artifact})
  const sourceRunId=randomUUID(),sourceReceipt=receipt(sourceRunId)
  const settings={harness:'codex',model:'synthetic-model',policyDigest:'2'.repeat(64),fixtureDigest:'3'.repeat(64),verifyCommand:REPORT_BENCHMARK.verifyCommand}
  const context={evaluationId,proposalId,instanceId,candidateVersionId:candidateArtifact.versionId,
    scope:{issueId,agentId,repoId,sourceCommit,factoryTaskId:taskId,candidateId},
    instance:{id:instanceId,userId,issueId,agentId,repoId,sourceRunId,sourceCommit,seed,settings,definitionDigest:REPORT_BENCHMARK.digest,instanceDigest:instance.digest},
    metadata:{versionId:candidateArtifact.versionId,userId,issueId,agentId,repoId,proposalId,factoryTaskId:taskId,candidateId,
      repository:'https://github.com/example/synthetic',commitSha:candidateCommitSha,path:SKILL_PATH,baselineVersionId:BASELINE_ARTIFACT.versionId},
    baselineVersion:{id:BASELINE_ARTIFACT.versionId,artifact:BASELINE_ARTIFACT,markdown:BASELINE_MARKDOWN},
    candidateVersion:{id:candidateArtifact.versionId,artifact:candidateArtifact,markdown},
    task:{id:taskId,userId,issueId,attemptId:randomUUID(),candidateId,status:'running'},
    factoryCandidate:{id:candidateId,taskId,sha:candidateCommitSha,repository:'https://github.com/example/synthetic'},
    sourceRun:{id:sourceRunId,userId,issueId,agentId,deviceRepoId:repoId,deviceId,status:'succeeded',startedAt,finishedAt,sessionId:'synthetic-source',stopRequestedAt:null,report:{sourceCommit}},
    sourceReceipt:{id:sourceReceipt.id,userId,runId:sourceRunId,receipt:sourceReceipt},
  }
  const runs=(['baseline','candidate'] as const).flatMap(arm=>REPORT_BENCHMARK.evaluationCaseIds.map(caseId=>{
    const runId=randomUUID(),sessionId=`synthetic-${runId}`,artifact=arm==='baseline'?BASELINE_ARTIFACT:candidateArtifact,assigned=receipt(runId,artifact)
    return {runId,instanceId,evaluationId,caseId,arm,versionId:artifact.versionId,userId,enabled:true,harness:'codex',repoPath:'/synthetic/case',
      run:{id:runId,userId,issueId,agentId,deviceId,deviceRepoId:repoId,status:'succeeded',sessionId,startedAt,finishedAt,stopRequestedAt:null,
        baseBranch:sourceCommit,prompt:buildTask(caseId,instance).prompt,report:{sourceCommit,summary:'Synthetic observed output; not a real quality result.',verify:{status:'passed',command:settings.verifyCommand,exitCode:0,timedOut:false,signal:null}}},
      mount:{runId,userId,deviceId,receiptId:assigned.id,versionId:artifact.versionId,sha256:artifact.sha256,sessionId,mountedAt,
        execution:{harness:settings.harness,requestedModel:settings.model,observedModel:settings.model,policyDigest:settings.policyDigest,
          fixtureDigest:settings.fixtureDigest,verifyCommand:settings.verifyCommand,sourceCommit,benchmarkDigest:instance.digest,caseId}},
      receipt:{id:assigned.id,userId,runId,receipt:assigned},
      selection:{runId,userId,issueId,agentId,repoId,deviceId,versionId:artifact.versionId},
      purpose:arm==='candidate'?{runId,userId,versionId:artifact.versionId,purpose:'evaluation',evaluationId}:null,
    }
  }))
  const objects=new Map<string,string>()
  const documents=[{runId:runs[0].runId,kind:'markdown',text:'# Synthetic observation\nNo real quality claim.'},
    {runId:runs.at(-1)!.runId,kind:'html',text:'<p>Synthetic observation</p><img src="https://untrusted.invalid/never-fetch.png">'}].map((item,index)=>{
    const artifactId=randomUUID(),sha256=hash(item.text),storageKey=`${userId}/${artifactId}/v1-${sha256.slice(0,12)}.${item.kind==='markdown'?'md':'html'}`
    objects.set(storageKey,item.text)
    return {artifactId,runId:item.runId,kind:item.kind,version:1,storageKey,inlineContent:index?null:item.text,sha256,size:Buffer.byteLength(item.text),createdAt:recordedAt}
  })
  const request={userId,issueId,proposalId,evaluationId}
  let authorized=true
  const queryCalls:{sql:string;values:unknown[]}[]=[]
  const pool={async query(sql:string,values:unknown[]){
    queryCalls.push({sql,values})
    const rows=sql.includes('SELECT e.id AS')?[context]:sql.includes('SELECT b.*')?runs:sql.includes('SELECT a.id AS')?documents:[]
    return {rows:structuredClone(rows)}
  }} as unknown as Pick<Pool,'query'>
  const readKeys:string[]=[]
  const readObject=async(key:string)=>{readKeys.push(key);const text=objects.get(key);if(text===undefined)throw Error('Unknown fixture key');return text}
  return {request,context,runs,documents,objects,pool,queryCalls,readObject,readKeys,
    authorize:async(user:string,issue:string)=>authorized&&user===userId&&issue===issueId,
    revoke:()=>{authorized=false}}
}
