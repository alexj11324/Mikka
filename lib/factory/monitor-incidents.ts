import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { digest } from "./evidence";
import { factoryCheckIndependent, type FactoryCheckTaskIdentity } from "./check-independence";
import { readFactoryPublicationReceiptV2 } from "./publication-receipt";
import { validateMonitorV2Observation, type MonitorV2Observation } from "./monitor-v2-binding";

export interface MonitorIncidentInput {
 ownerId: string; workspaceKey: string; fingerprint: string; checkKey: string;
 issueId: string; eventId: string; outcome: "unhealthy" | "healthy";
 publicationId: string; candidateId: string; runId: string; evidenceDigest: string;
}
/** Caller owns transaction and current authorized task/issue lock. No issue writes.
 * Healthy observations only mark recovery evidence; they never resolve an issue. */
export async function recordMonitorIncident(tx: PoolClient, input: MonitorIncidentInput) {
 if (Object.values(input).some(v => typeof v !== "string" || !v.trim())) throw Error("factoryMonitorIdentityRequired");
 const hash = digest(input);
 // Serialize event keys first, then incident keys, consistently for all consumers.
 await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["monitor-event", input.ownerId,input.eventId])]);
 const prior = await tx.query('SELECT payload_hash,incident_id FROM factory_monitor_observations WHERE owner_id=$1 AND event_id=$2',[input.ownerId,input.eventId]);
 if (prior.rows[0]) {
  if (prior.rows[0].payload_hash !== hash) throw Error("factoryMonitorReplayConflict");
  return { incidentId: prior.rows[0].incident_id as string, replayed: true };
 }
 await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["monitor-incident",input.ownerId,input.workspaceKey,input.fingerprint])]);
 let row = (await tx.query('SELECT * FROM factory_monitor_incidents WHERE owner_id=$1 AND workspace_key=$2 AND fingerprint=$3 FOR UPDATE',[input.ownerId,input.workspaceKey,input.fingerprint])).rows[0];
 if (row && (row.issue_id !== input.issueId || row.check_key !== input.checkKey)) throw Error("factoryMonitorIncidentConflict");
 if (!row) {
  if (input.outcome === "healthy") throw Error("factoryMonitorIncidentRequired");
  row = (await tx.query("INSERT INTO factory_monitor_incidents(id,owner_id,workspace_key,fingerprint,check_key,issue_id,status) VALUES($1,$2,$3,$4,$5,$6,'open') RETURNING *",[randomUUID(),input.ownerId,input.workspaceKey,input.fingerprint,input.checkKey,input.issueId])).rows[0];
 }
 await tx.query('INSERT INTO factory_monitor_observations(owner_id,event_id,payload_hash,incident_id,outcome,identity) VALUES($1,$2,$3,$4,$5,$6)',[input.ownerId,input.eventId,hash,row.id,input.outcome,JSON.stringify(input)]);
 await tx.query("UPDATE factory_monitor_incidents SET occurrences=occurrences+$2,status=$3 WHERE id=$1",[row.id,input.outcome === "unhealthy" ? 1 : 0,input.outcome === "healthy" ? "recovery_observed" : "open"]);
 return { incidentId: row.id as string, replayed: false };
}
/** Only a callback for the future #192 authorized transaction seam, not a route.
 * Both successful and failed observations consume the same actual #193 predicate. */
export async function consumeMonitorObservation(tx: PoolClient, task: FactoryCheckTaskIdentity, input: Omit<MonitorIncidentInput, "evidenceDigest">, observation: MonitorV2Observation, productionOrigin: string) {
 if (task.stage !== "monitor" || task.status !== "running" || !task.candidateId || input.ownerId !== task.userId || input.issueId !== task.issueId || input.candidateId !== task.candidateId || !await factoryCheckIndependent(tx,task,input.runId)) throw Error("factoryMonitorIndependentRequired");
 const receipt = await readFactoryPublicationReceiptV2(tx,task.userId,task.id,task.candidateId);
 if (receipt.publicationId !== input.publicationId) throw Error("factoryMonitorPublicationMismatch");
 const result = validateMonitorV2Observation(receipt,observation,productionOrigin);
 if (result === "blocked" || result !== input.outcome) throw Error("factoryMonitorObservationBlocked");
 if(result === "healthy") {
  const existing=await tx.query('SELECT id FROM factory_monitor_incidents WHERE owner_id=$1 AND workspace_key=$2 AND fingerprint=$3',[input.ownerId,input.workspaceKey,input.fingerprint]);
  if(!existing.rowCount) return {incidentId:null,replayed:false};
 }
 return recordMonitorIncident(tx,{ ...input, evidenceDigest: digest({ receipt, observation, artifact: `run-report:${input.runId}` }) });
}
