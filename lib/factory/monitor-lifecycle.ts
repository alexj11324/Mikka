import type { PoolClient } from "pg";
import {applyApprovalMode,defaultRunPolicy} from "@mikka/protocol/agent-policy";
import { FactoryError } from "./contract";
import type { FactoryTask, FactoryGate, createFactoryStore } from "./store";
import { factoryBinding } from "./dispatch";
import { factoryEventId } from "./event-id";
import { readFactoryPublicationReceiptV2 } from "./publication-receipt";
import { digest } from "./evidence";
import { consumeMonitorObservation, type MonitorIncidentInput } from "./monitor-incidents";
import { validateMonitorV2Observation, type MonitorV2Observation } from "./monitor-v2-binding";

/** Trusted persisted probe reader, never model handoff/report fields. It must
 * authenticate the server-owned artifact and bind its body to this run/session. */
export interface FactoryMonitorProof {
 observation: MonitorV2Observation;
 incident: Omit<MonitorIncidentInput,"evidenceDigest" | "outcome">;
 artifact: string; sessionId: string; recordedAt: string;
}
export function createFactoryMonitorConsumers(options: {
 productionOrigin: string;
 readProbe: (tx: PoolClient, task: FactoryTask, runId: string) => Promise<FactoryMonitorProof | null>;
}) {
 async function receipt(tx: PoolClient, task: FactoryTask) {
  if(task.stage!=="monitor"||!task.candidateId) throw new FactoryError("factoryMonitorCandidateRequired");
  return readFactoryPublicationReceiptV2(tx,task.userId,task.id,task.candidateId);
 }
 async function configure(tx: PoolClient, task: FactoryTask, runId: string) {
  const r=await receipt(tx,task);
  if(task.status!=="pending"||!r.verifiedTarget.provider) throw new FactoryError("factoryMonitorPublicationRequired");
  const updated=await tx.query(`UPDATE agent_runs SET kind='acceptance',"baseBranch"=$4 WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 AND status='queued' AND "stopRequestedAt" IS NULL RETURNING id`,[runId,task.userId,task.issueId,r.candidate.sha]);
  if(updated.rowCount!==1) throw new FactoryError("factoryRunMismatch");
  await tx.query(`UPDATE factory_attempts SET output=jsonb_set(COALESCE(output,'{}'::jsonb),'{monitorPublication}',$2::jsonb) WHERE id=$1 AND "taskId"=$3`,[task.attemptId,JSON.stringify({publicationId:r.publicationId,receiptDigest:digest(r),runId}),task.id]);
 }
 async function validateCheck(tx: PoolClient, task: FactoryTask, runId: string) {
  const r=await receipt(tx,task);
  const {rows:[a]}=await tx.query('SELECT a.output,r.* FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1 AND a."taskId"=$2 AND a."candidateId"=$3',[task.attemptId,task.id,task.candidateId]);
  if(task.status!=="running"||!a||a.id!==runId||a.userId!==task.userId||a.issueId!==task.issueId||a.stopRequestedAt||a.kind!=="acceptance"||a.baseBranch!==r.candidate.sha||a.output?.monitorPublication?.runId!==runId||a.output.monitorPublication.receiptDigest!==digest(r)) throw new FactoryError("factoryMonitorAssignmentRequired");
  return {baseBranch:r.candidate.sha,policy:applyApprovalMode(defaultRunPolicy(),"read_only")};
 }
 async function checked(tx:PoolClient,task:FactoryTask,runId:string) {
  await validateCheck(tx,task,runId);
  const r=await receipt(tx,task), proof=await options.readProbe(tx,task,runId);
  const {rows:[run]}=await tx.query('SELECT "sessionId" FROM agent_runs WHERE id=$1',[runId]);
  if(!proof||proof.incident.runId!==runId||!proof.sessionId||proof.sessionId!==run?.sessionId||proof.artifact!==`run-report:${runId}`||!Number.isFinite(Date.parse(proof.recordedAt))||Date.parse(proof.recordedAt)<Date.parse(proof.observation.finishedAt)) throw new FactoryError("factoryMonitorProofRequired");
  const outcome=validateMonitorV2Observation(r,proof.observation,options.productionOrigin);
  if(outcome==="blocked") throw new FactoryError("factoryMonitorObservationBlocked");
  return {r,proof,outcome};
 }
 const gate:FactoryGate=async(tx,task,attempt,change)=>{
  if(!attempt.runId||change.status!=="passed")return false;
  const {proof,outcome}=await checked(tx,task,attempt.runId);
  return outcome==="healthy"&&change.evidence.some(e=>e.artifact===proof.artifact&&e.runId===attempt.runId&&e.sessionId===proof.sessionId);
 };
 async function reconcile(tx:PoolClient,store:ReturnType<typeof createFactoryStore>,task:FactoryTask,run:Record<string,any>) {
  const {r,proof,outcome}=await checked(tx,task,String(run.id));
  await consumeMonitorObservation(tx,task,{...proof.incident,outcome},proof.observation,options.productionOrigin);
  return store.apply(task.userId,factoryBinding(task),factoryEventId("monitor-finish",task.attemptId),{
   action:"finish",status:outcome==="healthy"?"passed":"failed",reason:"Verified monitor observation recorded; no issue closure",
   evidence:[{artifact:proof.artifact,kind:"report",runId:String(run.id),sessionId:proof.sessionId,candidateId:task.candidateId,sha:r.candidate.sha,environment:r.candidate.environment,recordedAt:proof.recordedAt}],output:{monitorOutcome:outcome},
  },tx);
 }
 return {configure,validateCheck,gate,reconcile};
}
