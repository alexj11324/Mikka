import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { bindingSchema, FactoryError, type FactoryBinding } from "./contract";
import type { FactoryAuthorize, FactoryTask, FactoryAttempt } from "./store";
import { digest } from "./evidence";
import {
  readFactoryPublicationReceiptV2,
  verifiedPublicationTarget,
} from "./publication-receipt";
import { configuredVercelMonitorProbes } from "./vercel-monitor";
import { configuredLocalPublicationAdapters } from "./local-publication";
import { factoryEventId } from "./event-id";

export type MonitorPublication = Awaited<
  ReturnType<typeof readFactoryPublicationReceiptV2>
>;
const iso = z.iso.datetime();
export const monitorAuditSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    publicationId: z.uuid(),
    approvalId: z.uuid(),
    candidateId: z.uuid(),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repository: z.string(),
    environment: z.string(),
    scope: z.string(),
    action: z.enum(["deploy_preview", "deploy_production"]),
    target: z.string(),
    targetEnvironment: z.string(),
    kind: z.enum([
      "local-artifact",
      "preview-deployment",
      "production-deployment",
    ]),
    provider: verifiedPublicationTarget.shape.provider,
    health: z
      .object({
        path: z.literal("/mikka/api/health"),
        immutableStatus: z.number().int(),
        aliasOrigin: z.string().nullable(),
        aliasBefore: z.string().nullable(),
        aliasAfter: z.string().nullable(),
        aliasStatus: z.number().int().nullable(),
      })
      .strict()
      .optional(),
    operationId: z.string(),
    checkedReference: z.string(),
    requestId: z.uuid(),
    runId: z.uuid(),
    sessionId: z.string(),
    startedAt: iso,
    finishedAt: iso,
    command: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    observedSha: z.string(),
    observedTarget: z.string(),
    observedEnvironment: z.string(),
    observedOperationId: z.string(),
    observedReference: z.string(),
    errorCode: z.string().nullable(),
    logArtifacts: z.array(z.string()).length(1),
  })
  .strict();
export type MonitorAudit = z.infer<typeof monitorAuditSchema>;
const proofSchema = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid(),
    audit: monitorAuditSchema,
    artifact: z.string().regex(/^run-chunk:[a-f0-9-]{36}$/),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MonitorProof = z.infer<typeof proofSchema>;
export interface MonitorProbeAdapter {
  kind: "local-artifact" | "preview-deployment" | "production-deployment";
  target: string;
  environment: string;
  repository: string;
  execute(receipt: MonitorPublication): Promise<{
    command: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    observedSha: string;
    observedTarget: string;
    observedEnvironment: string;
    observedOperationId: string;
    observedReference: string;
    errorCode: string | null;
    stdout: string;
    stderr: string;
    provider?: MonitorAudit["provider"];
    health?: MonitorAudit["health"];
  }>;
}
const bindingFor = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});

// Static, trusted child program. Inputs choose neither code nor a path outside the registered root.
const localProgram = String.raw`
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const x=JSON.parse(process.argv[1]);
let out={observedSha:'unknown',observedTarget:'unknown',observedEnvironment:'unknown',observedOperationId:'unknown',observedReference:'unknown',errorCode:null};
const safe=(v,e)=>v===e?v:'mismatch:sha256:'+createHash('sha256').update(String(v)).digest('hex');
try {
 if(!isAbsolute(x.root)||(await lstat(x.root)).isSymbolicLink()||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x.operationId))throw Error('unsafe-target');
 const root=await realpath(x.root),path=join(root,x.operationId+'.json'),stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)throw Error('unsafe-target');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw;try{const buffer=Buffer.alloc(131073),read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead>131072)throw Error('unsafe-target');raw=buffer.subarray(0,read.bytesRead).toString('utf8');}finally{await handle.close();}
 const body=JSON.parse(raw),hash=createHash('sha256').update(raw).digest('hex');
 out={...out,observedSha:/^[a-f0-9]{40}$/.test(body.candidate?.sha)?body.candidate.sha:'unknown',
  observedTarget:safe(body.target,x.target),observedEnvironment:safe(body.targetEnvironment,x.targetEnvironment),
  observedOperationId:safe(body.idempotencyKey,x.operationId),observedReference:'local-artifact:'+x.operationId+':sha256:'+hash};
 const ok=out.observedSha===x.candidate.sha&&out.observedTarget===x.target&&out.observedEnvironment===x.targetEnvironment&&out.observedOperationId===x.operationId&&out.observedReference===x.reference&&['repository','environment','scope'].every(k=>body.candidate?.[k]===x.candidate[k]);
 out.errorCode=ok?null:'content-mismatch';console.log(JSON.stringify(out));process.exitCode=ok?0:1;
}catch(e){out.errorCode=e.code==='ENOENT'?'missing':e.message==='unsafe-target'?'unsafe-target':'read-error';console.log(JSON.stringify(out));process.exitCode=1;}
`;
const runFile = promisify(execFile);
export function createLocalMonitorProbe(config: {
  root: string;
  target: string;
  environment: string;
  repository: string;
}): MonitorProbeAdapter {
  if (!config.root.startsWith("/") || !/^local(?:-|$)/.test(config.environment))
    throw new FactoryError("factoryMonitorTargetInvalid");
  return {
    kind: "local-artifact",
    ...config,
    async execute(receipt) {
      const command = `node factory-local-artifact-readback:${createHash("sha256").update(localProgram).digest("hex")}`;
      let stdout = "",
        stderr = "",
        exitCode: number | null = 0,
        signal: string | null = null,
        timedOut = false;
      try {
        const result = await runFile(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            localProgram,
            JSON.stringify({
              root: config.root,
              operationId: receipt.verifiedTarget.operationId,
              target: receipt.target,
              targetEnvironment: receipt.targetEnvironment,
              candidate: receipt.candidate,
              reference: receipt.reference,
            }),
          ],
          { timeout: 5000, maxBuffer: 32768, env: { NODE_ENV: "test" } },
        );
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (value) {
        const error = value as {
          stdout?: string;
          stderr?: string;
          code?: number;
          signal?: string;
          killed?: boolean;
        };
        stdout = error.stdout ?? "";
        stderr = error.stderr ? "Local probe child failed" : "";
        exitCode = typeof error.code === "number" ? error.code : null;
        signal = error.signal ?? null;
        timedOut = Boolean(error.killed);
      }
      let observed: Record<string, string | null> = {};
      try {
        observed = JSON.parse(stdout);
      } catch {
        /* Missing child output remains blocked. */
      }
      return {
        command,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        observedSha: observed.observedSha ?? "unknown",
        observedTarget: observed.observedTarget ?? "unknown",
        observedEnvironment: observed.observedEnvironment ?? "unknown",
        observedOperationId: observed.observedOperationId ?? "unknown",
        observedReference: observed.observedReference ?? "unknown",
        errorCode:
          observed.errorCode ?? (exitCode === 0 ? null : "probe-error"),
      };
    },
  };
}
export function configuredMonitorProbes(
  env: Record<string, string | undefined>,
): MonitorProbeAdapter[] {
  const publication = configuredLocalPublicationAdapters(env);
  const cloud = configuredVercelMonitorProbes(env);
  if (!publication.length) return cloud;
  return [
    ...cloud,
    createLocalMonitorProbe({
      root: env.FACTORY_LOCAL_PUBLICATION_ROOT!,
      target: publication[0].target,
      environment: publication[0].environment,
      repository: env.FACTORY_LOCAL_PUBLICATION_REPOSITORY!,
    }),
  ];
}

/** Private backend producer. Existing daemon batches start at seq 1; seq 0 is a same-run artifact slot. */
export function createMonitorProbeRecorder(
  pool: Pool,
  authorize: FactoryAuthorize,
  adapters: MonitorProbeAdapter[],
) {
  return async (userId: string, runId: string) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const {
        rows: [task],
      } = await tx.query<FactoryTask>(
        `SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE a."runId"=$1 AND t."userId"=$2 AND t.stage='monitor' FOR UPDATE OF t`,
        [runId, userId],
      );
      if (!task) {
        await tx.query("COMMIT");
        return;
      }
      if (
        !(await authorize(userId, task.issueId, tx)) ||
        task.status !== "running" ||
        !task.candidateId
      )
        throw new FactoryError("factoryMonitorProbeStopped");
      const {
        rows: [run],
      } = await tx.query(
        `SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE`,
        [runId, userId, task.issueId],
      );
      if (
        !run ||
        !["running", "finishing"].includes(run.status) ||
        !run.sessionId ||
        !run.startedAt ||
        run.stopRequestedAt
      )
        throw new FactoryError("factoryMonitorProbeRunRequired");
      const receipt = await readFactoryPublicationReceiptV2(
        tx,
        userId,
        task.id,
        task.candidateId,
      );
      if (!monitorPublicationSupported(receipt))
        throw new FactoryError("factoryMonitorProbeUnavailable");
      const {
        rows: [attempt],
      } = await tx.query<FactoryAttempt>(
        "SELECT * FROM factory_attempts WHERE id=$1",
        [task.attemptId],
      );
      const eventId = factoryEventId("monitor-probe", runId),
        binding = bindingFor(task);
      if (attempt.output.monitorProof) {
        const prior = proofSchema.parse(attempt.output.monitorProof);
        if (
          prior.eventId !== eventId ||
          digest(prior.binding) !== digest(binding) ||
          prior.audit.publicationId !== receipt.publicationId
        )
          throw new FactoryError("factoryReplayMismatch");
        await tx.query("COMMIT");
        return prior.audit;
      }
      const adapter = adapters.find(
        (a) =>
          a.kind === receipt.verifiedTarget.kind &&
          a.target === receipt.target &&
          a.environment === receipt.targetEnvironment &&
          a.repository === receipt.candidate.repository,
      );
      if (!adapter) throw new FactoryError("factoryMonitorProbeUnavailable");
      const startedAt = new Date().toISOString(),
        result = await adapter.execute(receipt),
        finishedAt = new Date().toISOString();
      const artifactId = randomUUID(),
        artifact = `run-chunk:${artifactId}`;
      const audit = monitorAuditSchema.parse({
        version: receipt.verifiedTarget.provider ? 2 : 1,
        publicationId: receipt.publicationId,
        approvalId: receipt.approvalId,
        candidateId: task.candidateId,
        ...receipt.candidate,
        action: receipt.action,
        target: receipt.target,
        targetEnvironment: receipt.targetEnvironment,
        kind: receipt.verifiedTarget.kind,
        operationId: receipt.verifiedTarget.operationId,
        checkedReference: receipt.reference,
        requestId: randomUUID(),
        runId,
        sessionId: run.sessionId,
        startedAt,
        finishedAt,
        command: result.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        observedSha: result.observedSha,
        observedTarget: result.observedTarget,
        observedEnvironment: result.observedEnvironment,
        observedOperationId: result.observedOperationId,
        observedReference: result.observedReference,
        errorCode: result.errorCode,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.health ? { health: result.health } : {}),
        logArtifacts: [artifact],
      });
      const chunk = {
        type: "factory-monitor-probe",
        version: 1,
        binding,
        audit,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      const proof: MonitorProof = {
        binding,
        eventId,
        audit,
        artifact,
        artifactHash: digest(chunk),
      };
      await tx.query(
        'INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt") VALUES ($1,$2,0,$3,clock_timestamp())',
        [artifactId, runId, JSON.stringify(chunk)],
      );
      await tx.query(
        "UPDATE factory_attempts SET output=output || $2::jsonb WHERE id=$1",
        [task.attemptId, JSON.stringify({ monitorProof: proof })],
      );
      await tx.query("COMMIT");
      return audit;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  };
}

export async function validatedMonitorProof(
  tx: PoolClient,
  task: FactoryTask,
  attempt: FactoryAttempt,
  receipt: MonitorPublication,
  run: {
    id: string;
    sessionId: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  },
) {
  const parsed = proofSchema.safeParse(attempt.output.monitorProof);
  if (!parsed.success || !monitorPublicationSupported(receipt)) return;
  const proof = parsed.data,
    a = proof.audit,
    v = receipt.verifiedTarget;
  if (
    proof.eventId !== factoryEventId("monitor-probe", run.id) ||
    digest(proof.binding) !== digest(bindingFor(task)) ||
    a.publicationId !== receipt.publicationId ||
    a.approvalId !== receipt.approvalId ||
    a.candidateId !== task.candidateId ||
    a.sha !== receipt.candidate.sha ||
    a.repository !== receipt.candidate.repository ||
    a.environment !== receipt.candidate.environment ||
    a.scope !== receipt.candidate.scope ||
    a.action !== receipt.action ||
    a.target !== receipt.target ||
    a.targetEnvironment !== receipt.targetEnvironment ||
    a.kind !== v.kind ||
    a.operationId !== v.operationId ||
    a.checkedReference !== receipt.reference ||
    a.runId !== run.id ||
    a.sessionId !== run.sessionId ||
    a.logArtifacts[0] !== proof.artifact
  )
    return;
  if (
    v.provider &&
    (!a.provider ||
      a.version !== 2 ||
      digest(a.provider) !== digest(v.provider) ||
      !a.health)
  )
    return;
  if (!v.provider && (a.version !== 1 || a.provider || a.health)) return;
  const start = Date.parse(a.startedAt),
    end = Date.parse(a.finishedAt);
  if (
    !run.startedAt ||
    !run.finishedAt ||
    start < Date.parse(receipt.publishedAt) ||
    start < Date.parse(v.observedAt) ||
    start < new Date(run.startedAt).getTime() ||
    end < start ||
    end > new Date(run.finishedAt).getTime()
  )
    return;
  const {
    rows: [row],
  } = await tx.query(
    'SELECT * FROM run_chunks WHERE id=$1 AND "runId"=$2 AND seq=0',
    [proof.artifact.slice("run-chunk:".length), run.id],
  );
  if (
    !row ||
    new Date(row.createdAt).getTime() > new Date(run.finishedAt).getTime() ||
    row.chunk?.type !== "factory-monitor-probe" ||
    !monitorAuditSchema.safeParse(row.chunk.audit).success ||
    !bindingSchema.safeParse(row.chunk.binding).success ||
    digest(row.chunk) !== proof.artifactHash ||
    digest(row.chunk.audit) !== digest(a) ||
    digest(row.chunk.binding) !== digest(proof.binding)
  )
    return;
  return proof;
}
export function monitorProbePassed(a: MonitorAudit, r: MonitorPublication) {
  return (
    monitorPublicationSupported(r) &&
    (!r.verifiedTarget.provider ||
      (a.provider !== undefined &&
        a.version === 2 &&
        digest(a.provider) === digest(r.verifiedTarget.provider) &&
        a.health?.path === "/mikka/api/health" &&
        a.health.immutableStatus === 200 &&
        (r.action === "deploy_production"
          ? a.health.aliasOrigin === "https://app.aspectlylabs.com" &&
            a.health.aliasBefore === r.verifiedTarget.operationId &&
            a.health.aliasAfter === r.verifiedTarget.operationId &&
            a.health.aliasStatus === 200
          : a.health.aliasOrigin === null &&
            a.health.aliasBefore === null &&
            a.health.aliasAfter === null &&
            a.health.aliasStatus === null))) &&
    a.exitCode === 0 &&
    !a.signal &&
    !a.timedOut &&
    !a.errorCode &&
    a.observedSha === r.candidate.sha &&
    a.observedTarget === r.target &&
    a.observedEnvironment === r.targetEnvironment &&
    a.observedOperationId === r.verifiedTarget.operationId &&
    a.observedReference === r.reference
  );
}

/** Only established target health faults trigger repair. Unknown identity,
 * moved production aliases, missing credentials and transport uncertainty block. */
export function monitorProbeFailed(
  a: MonitorAudit,
  r: MonitorPublication,
): boolean {
  if (a.timedOut || a.signal || !monitorPublicationSupported(r)) return false;
  if (r.verifiedTarget.kind === "local-artifact")
    return ["content-mismatch", "missing"].includes(a.errorCode ?? "");
  return Boolean(
    a.provider &&
    r.verifiedTarget.provider &&
    a.version === 2 &&
    digest(a.provider) === digest(r.verifiedTarget.provider) &&
    a.observedSha === r.candidate.sha &&
    a.observedTarget === r.target &&
    a.observedEnvironment === r.targetEnvironment &&
    a.observedOperationId === r.verifiedTarget.operationId &&
    a.observedReference === r.reference &&
    a.health?.path === "/mikka/api/health" &&
    (r.action !== "deploy_production" ||
      (a.health.aliasOrigin === "https://app.aspectlylabs.com" &&
        a.health.aliasBefore === r.verifiedTarget.operationId &&
        a.health.aliasAfter === r.verifiedTarget.operationId)) &&
    (/^health-http-5\d\d$/.test(a.errorCode ?? "") ||
      a.errorCode === "health-invalid"),
  );
}

/** Explicit V2 adoption; old preview/local receipts can never represent production. */
export function monitorPublicationSupported(r: MonitorPublication): boolean {
  const v = r.verifiedTarget;
  if (v.kind === "local-artifact")
    return r.action === "deploy_preview" && !v.provider;
  if (!v.provider || r.version !== 2) return false;
  return (
    (r.action === "deploy_production" &&
      v.kind === "production-deployment" &&
      r.targetEnvironment === "production" &&
      v.provider.environment === "production") ||
    (r.action === "deploy_preview" &&
      v.kind === "preview-deployment" &&
      r.targetEnvironment === "preview" &&
      v.provider.environment === "preview")
  );
}
