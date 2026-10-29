import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { MAX_SKILL_INSTRUCTIONS_LENGTH,skillArtifactRefSchema, skillAssignmentReceiptSchema, skillMarkdown, type SkillArtifactRef } from '@mikka/protocol/skill'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN, BASELINE_SKILL } from './builtin-skill'
import { digest } from './contract'
import { SKILL_PATH } from './regression'
import { REPORT_BENCHMARK, buildTask, freezeBenchmarkInstance } from './report-benchmark'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const time=(value:unknown)=>new Date(value as string).getTime()
const validSha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)
const SKILL_HEADER='---\nname: Run report\n---\n\n'
// Transport bounds only, not model budgets, benchmark/scorer thresholds or
// effect judgments. Reuse #192's 64KB text bound conservatively across a read.
export const COMPARISON_TEXT_BOUNDS=Object.freeze({maxVersions:100,maxBytes:64000})
const settingsSchema=z.object({harness:z.string().min(1),model:z.string().min(1),policyDigest:z.string().regex(/^[a-f0-9]{64}$/),
  fixtureDigest:z.string().regex(/^[a-f0-9]{64}$/),verifyCommand:z.literal(REPORT_BENCHMARK.verifyCommand)}).strict()
export interface RegisteredComparisonRequest {userId:string;issueId:string;proposalId:string;evaluationId?:string}
export interface CollectedTextArtifact {artifactId:string;version:number;digest:string;kind:'markdown'|'html';text:string;recordedAt:string}
export interface RegisteredCaseObservation {
  caseId:string;arm:'baseline'|'candidate';runId:string;sessionId:string;deviceId:string;sourceCommit:string;
  artifact:SkillArtifactRef;mountReceiptId:string;startedAt:string;finishedAt:string;mountedAt:string;
  output:string;outputDigest:string;documents:CollectedTextArtifact[];
}
export interface RegisteredSkillComparison {
  evaluationId:string;proposalId:string;issueId:string;instanceId:string;instanceDigest:string;definitionDigest:string;
  sourceCommit:string;candidateCommitSha:string;settings:z.infer<typeof settingsSchema>;
  baseline:{artifact:SkillArtifactRef;markdown:string};candidate:{artifact:SkillArtifactRef;markdown:string};
  documentDigests:{baseline:string;candidate:string};
  tasks:ReturnType<typeof buildTask>[];baselineRuns:RegisteredCaseObservation[];candidateRuns:RegisteredCaseObservation[];
  requiresVisual:false;evidenceDigest:string;
}

/** Read-only adapter for #316's existing case/arm/mount ledgers and main's
 * actual artifact_versions + storage. No new registry, assignments or tables.
 * #192's text-reader owner/run/version/hash/time checks are preserved without
 * incorrectly requiring benchmark runs to be Factory stage attempts. */
export function createSkillComparisonCollector(pool:Pick<Pool,'query'>,
  authorize:(userId:string,issueId:string)=>Promise<boolean>,readObject:(key:string)=>Promise<string>) {
  async function snapshot(request:RegisteredComparisonRequest) {
    if(!z.uuid().safeParse(request.proposalId).success||!z.uuid().safeParse(request.issueId).success||
      (request.evaluationId!==undefined&&!z.uuid().safeParse(request.evaluationId).success)||
      !await authorize(request.userId,request.issueId))return null
    const {rows:contexts}=await pool.query(`SELECT e.id AS "evaluationId",e."proposalId",e."instanceId",e."candidateVersionId",e.scope,
      to_jsonb(i) AS instance,to_jsonb(meta) AS metadata,to_jsonb(cv) AS "candidateVersion",to_jsonb(bv) AS "baselineVersion",
      to_jsonb(t) AS task,to_jsonb(c) AS "factoryCandidate",to_jsonb(sr) AS "sourceRun",to_jsonb(src) AS "sourceReceipt"
      FROM improvement_skill_evaluations e JOIN improvement_benchmark_instances i ON i.id=e."instanceId" AND i."userId"=e."userId"
      JOIN improvement_skill_candidates meta ON meta."versionId"=e."candidateVersionId" AND meta."userId"=e."userId" AND meta."proposalId"=e."proposalId"
      JOIN improvement_skill_versions cv ON cv.id=meta."versionId" JOIN improvement_skill_versions bv ON bv.id=meta."baselineVersionId"
      JOIN factory_tasks t ON t.id=meta."factoryTaskId" AND t."userId"=e."userId" AND t."issueId"=i."issueId"
      JOIN factory_candidates c ON c.id=meta."candidateId" AND c."taskId"=t.id
      JOIN agent_runs sr ON sr.id=i."sourceRunId" AND sr."userId"=e."userId" AND sr."issueId"=i."issueId"
      JOIN agents sa ON sa.id=sr."agentId" AND sa."userId"=e."userId" AND sa."deviceId"=sr."deviceId"
      JOIN devices sd ON sd.id=sr."deviceId" AND sd."ownerId"=e."userId" AND sd.enabled=true
      JOIN device_repos srepo ON srepo.id=sr."deviceRepoId" AND srepo."userId"=e."userId" AND srepo."deviceId"=sr."deviceId"
      JOIN improvement_skill_receipts src ON src."runId"=sr.id AND src."userId"=e."userId"
      WHERE e."userId"=$1 AND e."proposalId"=$2 AND i."issueId"=$3 AND ($4::uuid IS NULL OR e.id=$4)
      AND NOT EXISTS(SELECT 1 FROM improvement_skill_lifecycle l WHERE l."versionId"=meta."versionId" AND l."userId"=e."userId" AND l.operation='withdraw')
      ORDER BY e.id LIMIT 2`,[request.userId,request.proposalId,request.issueId,request.evaluationId??null])
    // An explicit frozen evaluation is required when a proposal has more than
    // one. Never pick the best-looking/latest arm after observing outcomes.
    if(contexts.length!==1)return null
    const context=contexts[0]
    const {rows:runs}=await pool.query(`SELECT b.*,to_jsonb(r) AS run,to_jsonb(m) AS mount,to_jsonb(rc) AS receipt,
      to_jsonb(s) AS selection,to_jsonb(p) AS purpose,a.harness,d.enabled,repo."repoPath"
      FROM improvement_benchmark_runs b JOIN agent_runs r ON r.id=b."runId" AND r."userId"=b."userId"
      JOIN agents a ON a.id=r."agentId" AND a."userId"=b."userId" AND a."deviceId"=r."deviceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=b."userId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=b."userId" AND repo."deviceId"=r."deviceId"
      JOIN improvement_skill_mounts m ON m."runId"=r.id AND m."userId"=b."userId"
      JOIN improvement_skill_receipts rc ON rc.id=m."receiptId" AND rc."runId"=r.id AND rc."userId"=b."userId"
      JOIN improvement_skill_selections s ON s."runId"=r.id AND s."userId"=b."userId"
      LEFT JOIN improvement_skill_run_purposes p ON p."runId"=r.id AND p."userId"=b."userId"
      WHERE b."evaluationId"=$1 AND b."instanceId"=$2 AND b."userId"=$3 ORDER BY b.arm,b."caseId",b."runId"`,
    [context.evaluationId,context.instanceId,request.userId])
    const {rows:documents}=await pool.query(`SELECT a.id AS "artifactId",a."runId",a.kind,v.version,v."storageKey",v."inlineContent",v.sha256,v.size,v."createdAt"
      FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
      JOIN agent_runs r ON r.id=a."runId" AND r."userId"=a."userId" AND r."issueId"=a."issueId"
      WHERE a."userId"=$1 AND a."issueId"=$2 AND a."runId"=ANY($3::uuid[]) ORDER BY a.id,v.version LIMIT 101`,
    [request.userId,request.issueId,runs.map(row=>row.runId)])
    return {context,runs,documents}
  }
  function version(row:{artifact:unknown;markdown:unknown},baseline:boolean) {
    const artifact=skillArtifactRefSchema.parse(row.artifact)
    if(typeof row.markdown!=='string'||Buffer.byteLength(row.markdown)>MAX_SKILL_INSTRUCTIONS_LENGTH+Buffer.byteLength(SKILL_HEADER)+1||hash(row.markdown)!==artifact.sha256||
      artifact.skillId!==BASELINE_SKILL.id||artifact.registryId!==BASELINE_ARTIFACT.registryId||artifact.format!==BASELINE_ARTIFACT.format)return null
    if(!row.markdown.startsWith(SKILL_HEADER)||Buffer.byteLength(row.markdown.slice(SKILL_HEADER.length).trim())>MAX_SKILL_INSTRUCTIONS_LENGTH||
      skillMarkdown({...BASELINE_SKILL,instructions:row.markdown.slice(SKILL_HEADER.length).trim()})!==row.markdown)return null
    if(baseline&&(digest(artifact)!==digest(BASELINE_ARTIFACT)||row.markdown!==BASELINE_MARKDOWN))return null
    return {artifact,markdown:row.markdown}
  }
  return async function loadComparison(request:RegisteredComparisonRequest):Promise<RegisteredSkillComparison|null> {
    try {
      const before=await snapshot(request)
      if(!before)return null
      const {context,runs,documents}=before,i=context.instance,meta=context.metadata,t=context.task,c=context.factoryCandidate,sr=context.sourceRun
      const outputBytes=runs.reduce((sum,row)=>sum+(typeof row.run?.report?.summary==='string'?Buffer.byteLength(row.run.report.summary):0),0)
      if(documents.length>COMPARISON_TEXT_BOUNDS.maxVersions||documents.some(document=>!Number.isSafeInteger(document.size)||document.size<1)||
        documents.reduce((sum,document)=>sum+document.size,outputBytes)>COMPARISON_TEXT_BOUNDS.maxBytes)return null
      let actualTextBytes=outputBytes
      const instance=freezeBenchmarkInstance(i.seed),settings=settingsSchema.parse(i.settings)
      const baseline=version(context.baselineVersion,true),candidate=version(context.candidateVersion,false)
      const sourceReceipt=skillAssignmentReceiptSchema.parse(context.sourceReceipt.receipt)
      if(!baseline||!candidate||candidate.artifact.versionId===baseline.artifact.versionId||
        context.baselineVersion.id!==baseline.artifact.versionId||context.candidateVersion.id!==candidate.artifact.versionId||
        i.definitionDigest!==REPORT_BENCHMARK.digest||i.instanceDigest!==instance.digest||
        !validSha(i.sourceCommit)||!validSha(meta.commitSha)||meta.commitSha!==c.sha||meta.repository!==c.repository||
        meta.path!==SKILL_PATH||meta.baselineVersionId!==baseline.artifact.versionId||meta.versionId!==candidate.artifact.versionId||
        meta.issueId!==i.issueId||meta.agentId!==i.agentId||meta.repoId!==i.repoId||
        t.candidateId!==meta.candidateId||['cancelled','revoked'].includes(t.status)||
        digest(context.scope)!==digest({issueId:i.issueId,agentId:i.agentId,repoId:i.repoId,sourceCommit:i.sourceCommit,factoryTaskId:t.id,candidateId:c.id})||
        !['succeeded','failed'].includes(sr.status)||sr.stopRequestedAt||!sr.startedAt||!sr.finishedAt||!sr.sessionId||
        !Number.isFinite(time(sr.startedAt))||!Number.isFinite(time(sr.finishedAt))||time(sr.startedAt)>time(sr.finishedAt)||time(sr.finishedAt)>Date.now()||
        sr.agentId!==i.agentId||sr.deviceRepoId!==i.repoId||sr.report?.sourceCommit!==i.sourceCommit||
        sourceReceipt.id!==context.sourceReceipt.id||sourceReceipt.runId!==sr.id||sourceReceipt.issueId!==i.issueId||sourceReceipt.agentId!==i.agentId||sourceReceipt.repoId!==i.repoId||sourceReceipt.deviceId!==sr.deviceId||
        time(sourceReceipt.assignedAt)<time(sr.startedAt)||time(sourceReceipt.assignedAt)>time(sr.finishedAt)||
        digest(sourceReceipt.artifact)!==digest(BASELINE_ARTIFACT))return null
      const ids=REPORT_BENCHMARK.evaluationCaseIds
      if(runs.length!==ids.length*2||new Set(runs.map(row=>row.runId)).size!==runs.length||
        new Set(runs.map(row=>row.run.sessionId)).size!==runs.length)return null
      const arms:{baseline:RegisteredCaseObservation[];candidate:RegisteredCaseObservation[]}={baseline:[],candidate:[]}
      for(const arm of ['baseline','candidate'] as const)for(const caseId of ids){
        const matches=runs.filter(row=>row.arm===arm&&row.caseId===caseId)
        if(matches.length!==1)return null
        const row=matches[0],r=row.run,m=row.mount,receipt=skillAssignmentReceiptSchema.parse(row.receipt.receipt)
        const artifact=arm==='baseline'?baseline.artifact:candidate.artifact
        const expectedExecution={harness:settings.harness,requestedModel:settings.model,observedModel:settings.model,
          policyDigest:settings.policyDigest,fixtureDigest:settings.fixtureDigest,verifyCommand:settings.verifyCommand,
          sourceCommit:i.sourceCommit,benchmarkDigest:i.instanceDigest,caseId}
        if(!row.enabled||r.status!=='succeeded'||r.stopRequestedAt||!r.startedAt||!r.finishedAt||!r.sessionId||
          !Number.isFinite(time(r.startedAt))||time(r.startedAt)>time(r.finishedAt)||!Number.isFinite(time(r.finishedAt))||time(r.finishedAt)>Date.now()||
          r.issueId!==i.issueId||r.agentId!==i.agentId||r.deviceRepoId!==i.repoId||r.baseBranch!==i.sourceCommit||
          r.prompt!==buildTask(caseId,instance).prompt||row.harness!==settings.harness||row.versionId!==artifact.versionId||
          row.selection.versionId!==artifact.versionId||row.selection.issueId!==i.issueId||row.selection.agentId!==i.agentId||
          row.selection.repoId!==i.repoId||row.selection.deviceId!==r.deviceId||
          m.sessionId!==r.sessionId||m.deviceId!==r.deviceId||m.receiptId!==row.receipt.id||receipt.id!==row.receipt.id||m.versionId!==artifact.versionId||m.sha256!==artifact.sha256||
          time(m.mountedAt)<time(r.startedAt)||time(m.mountedAt)>time(r.finishedAt)||!Number.isFinite(time(m.mountedAt))||
          digest(m.execution)!==digest(expectedExecution)||receipt.runId!==r.id||receipt.issueId!==i.issueId||receipt.agentId!==i.agentId||
          receipt.repoId!==i.repoId||receipt.deviceId!==r.deviceId||digest(receipt.artifact)!==digest(artifact)||
          time(receipt.assignedAt)<time(r.startedAt)||time(receipt.assignedAt)>time(m.mountedAt)||
          (arm==='candidate'&&(row.purpose?.purpose!=='evaluation'||row.purpose.evaluationId!==context.evaluationId||row.purpose.versionId!==artifact.versionId))||
          r.report?.sourceCommit!==i.sourceCommit||r.report.verify?.status!=='passed'||r.report.verify.command!==settings.verifyCommand||
          r.report.verify.exitCode!==0||r.report.verify.timedOut===true||r.report.verify.signal!=null||
          typeof r.report.summary!=='string'||!r.report.summary.length||Buffer.byteLength(r.report.summary)>REPORT_BENCHMARK.rules.maxOutputBytes)return null
        const readDocuments:CollectedTextArtifact[]=[]
        for(const document of documents.filter(doc=>doc.runId===r.id)){
          // Adapted from #192 text-observation: actual immutable version and
          // owner-scoped storage key only; never fetch a document's URLs.
          if(!z.uuid().safeParse(document.artifactId).success||!['markdown','html'].includes(document.kind)||!Number.isSafeInteger(document.version)||document.version<1||
            !Number.isSafeInteger(document.size)||document.size<1||document.size>64000||
            !/^[a-f0-9]{64}$/.test(document.sha256)||time(document.createdAt)<time(m.mountedAt)||
            time(document.createdAt)>time(r.finishedAt)||!Number.isFinite(time(document.createdAt)))return null
          const key=`${request.userId}/${document.artifactId}/v${document.version}-${document.sha256.slice(0,12)}.${document.kind==='markdown'?'md':'html'}`
          if(document.storageKey!==key)return null
          const text=document.inlineContent??await readObject(key)
          if(typeof text!=='string'||Buffer.byteLength(text)!==document.size||hash(text)!==document.sha256)return null
          actualTextBytes+=Buffer.byteLength(text)
          if(actualTextBytes>COMPARISON_TEXT_BOUNDS.maxBytes)return null
          readDocuments.push({artifactId:document.artifactId,version:document.version,digest:document.sha256,kind:document.kind,
            text,recordedAt:new Date(document.createdAt).toISOString()})
        }
        arms[arm].push({caseId,arm,runId:r.id,sessionId:r.sessionId,deviceId:r.deviceId,sourceCommit:i.sourceCommit,artifact,
          mountReceiptId:m.receiptId,startedAt:new Date(r.startedAt).toISOString(),finishedAt:new Date(r.finishedAt).toISOString(),
          mountedAt:new Date(m.mountedAt).toISOString(),output:r.report.summary,outputDigest:hash(r.report.summary),documents:readDocuments})
      }
      // Storage I/O holds no connection/lock. Re-read current authorization,
      // Factory/case/run/version/mount/document bindings before returning bytes.
      const after=await snapshot(request)
      if(!after||hash(JSON.stringify(before))!==hash(JSON.stringify(after)))return null
      return {evaluationId:context.evaluationId,proposalId:request.proposalId,issueId:request.issueId,instanceId:i.id,
        instanceDigest:i.instanceDigest,definitionDigest:i.definitionDigest,sourceCommit:i.sourceCommit,candidateCommitSha:meta.commitSha,
        settings,baseline,candidate,documentDigests:{
          baseline:digest(baseline.markdown.slice(SKILL_HEADER.length).trim()+'\n'),
          candidate:digest(candidate.markdown.slice(SKILL_HEADER.length).trim()+'\n')},
        tasks:ids.map(caseId=>buildTask(caseId,instance)),baselineRuns:arms.baseline,candidateRuns:arms.candidate,
        requiresVisual:false,evidenceDigest:hash(JSON.stringify(before))}
    }catch{return null}
  }
}
