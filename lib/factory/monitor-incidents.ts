import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { digest } from "./evidence";
import { factoryEventId } from "./event-id";
import { factoryCheckIndependent, type FactoryCheckTaskIdentity } from "./check-independence";
import { readFactoryPublicationReceiptV2 } from "./publication-receipt";
import { validateMonitorV2Observation, type MonitorV2Observation } from "./monitor-v2-binding";

export interface MonitorIncidentInput {
  ownerId: string; workspaceKey: string; fingerprint: string; checkKey: string;
  issueId: string; eventId: string; outcome: "unhealthy" | "healthy";
  publicationId: string; candidateId: string; runId: string; evidenceDigest: string;
}

/** One incident ledger for the event consumer and receipt-bound host adapter.
 * The caller holds its authorized task/issue transaction. Recovery records
 * evidence on the existing issue; it never closes or creates an issue. */
export async function recordMonitorIncidentState(tx: PoolClient, input: {
  ownerId: string; workspaceKey: string; fingerprint: string; checkKey: string;
  issueId: string; taskId: string; candidateId: string;
  outcome: "unhealthy" | "healthy"; observationId?: string;
}) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["monitor-incident",input.ownerId,input.workspaceKey,input.fingerprint])]);
  let row = (await tx.query('SELECT * FROM factory_monitor_incidents WHERE "userId"=$1 AND "workspaceKey"=$2 AND fingerprint=$3 FOR UPDATE',[input.ownerId,input.workspaceKey,input.fingerprint])).rows[0];
  if (row && (row.issueId !== input.issueId || row.checkKey !== input.checkKey)) throw Error("factoryMonitorIncidentConflict");
  if (!row) {
    if (input.outcome === "healthy") throw Error("factoryMonitorIncidentRequired");
    row = (await tx.query(`INSERT INTO factory_monitor_incidents(id,"userId","workspaceKey",fingerprint,"checkKey","issueId","taskId","candidateId",status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING *`,[randomUUID(),input.ownerId,input.workspaceKey,input.fingerprint,input.checkKey,input.issueId,input.taskId,input.candidateId])).rows[0];
  }
  await tx.query(`UPDATE factory_monitor_incidents SET occurrences=occurrences+$2,status=$3,"recoveredObservationId"=$4,"updatedAt"=clock_timestamp() WHERE id=$1`,[row.id,input.outcome === "unhealthy" ? 1 : 0,input.outcome === "healthy" ? "recovered" : "open",input.outcome === "healthy" ? input.observationId ?? null : null]);
  return { ...row, occurrences: row.occurrences + (input.outcome === "unhealthy" ? 1 : 0) };
}

/** Atomically consumes a host observation into the tracked #195 tables. */
export async function recordMonitorIncident(tx: PoolClient, input: MonitorIncidentInput) {
  if (Object.values(input).some(v => typeof v !== "string" || !v.trim())) throw Error("factoryMonitorIdentityRequired");
  const hash = digest(input), eventId = factoryEventId("monitor-v2-observation",input.eventId);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["monitor-event",input.ownerId,eventId])]);
  const prior = (await tx.query('SELECT request,"incidentId" FROM factory_monitor_observations WHERE "userId"=$1 AND "sourceEventId"=$2',[input.ownerId,eventId])).rows[0];
  if (prior) {
    if (prior.request?.payloadHash !== hash) throw Error("factoryMonitorReplayConflict");
    return { incidentId: prior.incidentId as string, replayed: true };
  }
  const identity = (await tx.query(`SELECT t.id AS "taskId",r."sessionId" FROM factory_candidates c
    JOIN factory_tasks t ON t.id=c."taskId" AND t."userId"=$1 AND t."issueId"=$2
    JOIN agent_runs r ON r.id=$4 AND r."userId"=$1 AND r."issueId"=$2
    WHERE c.id=$3`,[input.ownerId,input.issueId,input.candidateId,input.runId])).rows[0];
  if (!identity?.sessionId) throw Error("factoryMonitorIdentityRequired");
  const id = randomUUID();
  const incident = await recordMonitorIncidentState(tx,{...input,taskId:identity.taskId,observationId:id});
  await tx.query(`INSERT INTO factory_monitor_observations(id,"userId","workspaceKey","sourceEventId","runId","sessionId","taskId","candidateId","incidentId","checkKey",request,evidence,outcome)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,input.ownerId,input.workspaceKey,eventId,input.runId,identity.sessionId,identity.taskId,input.candidateId,incident.id,input.checkKey,JSON.stringify({version:2,payloadHash:hash,identity:input}),JSON.stringify([{artifact:`run-report:${input.runId}`,evidenceDigest:input.evidenceDigest}]),input.outcome === "healthy" ? "passed" : "failed"]);
  return { incidentId: incident.id as string, replayed: false };
}

/** Both successful and failed observations consume the same actual ancestry predicate. */
export async function consumeMonitorObservation(tx: PoolClient, task: FactoryCheckTaskIdentity, input: Omit<MonitorIncidentInput, "evidenceDigest">, observation: MonitorV2Observation, productionOrigin: string) {
  if (task.stage !== "monitor" || task.status !== "running" || !task.candidateId || input.ownerId !== task.userId || input.issueId !== task.issueId || input.candidateId !== task.candidateId || !await factoryCheckIndependent(tx,task,input.runId)) throw Error("factoryMonitorIndependentRequired");
  const receipt = await readFactoryPublicationReceiptV2(tx,task.userId,task.id,task.candidateId);
  if (receipt.publicationId !== input.publicationId) throw Error("factoryMonitorPublicationMismatch");
  const result = validateMonitorV2Observation(receipt,observation,productionOrigin);
  if (result === "blocked" || result !== input.outcome) throw Error("factoryMonitorObservationBlocked");
  if (result === "healthy") {
    const existing=await tx.query('SELECT id FROM factory_monitor_incidents WHERE "userId"=$1 AND "workspaceKey"=$2 AND fingerprint=$3',[input.ownerId,input.workspaceKey,input.fingerprint]);
    if (!existing.rowCount) return {incidentId:null,replayed:false};
  }
  return recordMonitorIncident(tx,{...input,evidenceDigest:digest({receipt,observation,artifact:`run-report:${input.runId}`})});
}
