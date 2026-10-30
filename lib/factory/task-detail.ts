import type { PoolClient } from "pg";
import { VERIFY_STATUSES, type VerifyStatus } from "@mikka/protocol/run";
import { redactFactoryCheckText } from "./checks";
import { FACTORY_STATUSES, type FactoryStatus } from "./contract";

/** B8/B9 (Figma 357:4750): one row per review/verify/monitor attempt. Read-only. */
export interface FactoryCheckCriterion {
  criterionId: string | null;
  text: string | null;
  passed: boolean;
  evidence: string | null;
}
export interface FactoryCheckResult {
  attemptId: string;
  stage: "review" | "verify" | "monitor";
  /** Closed union, same values as the factory_attempts CHECK constraint. Rows with any other value are dropped. */
  status: FactoryStatus;
  /** The candidate this check ran against (factory_attempts.candidateId); null = not bound to a candidate. */
  candidateId: string | null;
  /** That candidate's commit sha; null when candidateId is null. */
  candidateSha: string | null;
  runId: string | null;
  /** true/false = ancestry predicate result; null = no run yet. */
  independent: boolean | null;
  criteria: FactoryCheckCriterion[];
  /** null when the run has no report, or report.verify.status is not one of VERIFY_STATUSES. command is null when the report has none. */
  verify: { status: VerifyStatus; command: string | null; exitCode: number | null } | null;
}
/** B11 header (the rest of #445's list fields, on the detail). */
export interface FactoryDelivery {
  candidateSha: string | null;
  pullRequest: { url: string; state: "open" | "draft" | "merged" | "closed" } | null;
  /** factory_candidates.repository of the current candidate (e.g. "owner/repo"). */
  repository: string | null;
  /** factory_candidates.environment: where the candidate was built (e.g. "device:<id>"), not a deploy target. */
  environment: string | null;
  /**
   * Source of truth: receipt.verifiedTarget.reference (provider-confirmed) of the newest succeeded
   * preview publication of the current candidate. previewUrl is exactly that value, kept only when it
   * is https; an http latest reference yields null (no fallback to an older https one).
   */
  previewUrl: string | null;
  /** Neon branch of the run. Mikka does not record one anywhere yet, so this is always null. */
  databaseBranch: { name: string; url: string } | null;
  /**
   * Vercel's deployment target as recorded in receipt.verifiedTarget.provider.environment (provider
   * name "vercel") of the newest succeeded publication of the current candidate. Any other value, a
   * receipt without a Vercel provider, or no receipt gives null. Never inferred from branch names.
   */
  deploymentEnvironment: "preview" | "production" | null;
}
export interface FactoryTaskDetail { checks: FactoryCheckResult[]; delivery: FactoryDelivery }
type Task = { id: string; issueId: string; candidateId: string | null; userId: string };
type Independent = (tx: PoolClient, task: never, runId: string) => Promise<boolean>;

const text = (v: unknown) => (typeof v === "string" && v.trim() ? redactFactoryCheckText(v) : null);

export function factoryCriteria(report: unknown): FactoryCheckCriterion[] {
  const list = (report as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(list)) return [];
  // Filter first, then cap, so malformed entries never take one of the 200 slots.
  return list.flatMap((c) =>
    c && typeof c === "object" && typeof (c as { passed?: unknown }).passed === "boolean"
      ? [{
          criterionId: typeof (c as { criterionId?: unknown }).criterionId === "string" ? (c as { criterionId: string }).criterionId : null,
          text: text((c as { text?: unknown }).text),
          passed: (c as { passed: boolean }).passed,
          evidence: text((c as { evidence?: unknown }).evidence),
        }]
      : [],
  ).slice(0, 200);
}
function verifyOf(report: unknown): FactoryCheckResult["verify"] {
  const v = (report as { verify?: Record<string, unknown> } | null)?.verify;
  if (!v || !(VERIFY_STATUSES as readonly unknown[]).includes(v.status)) return null;
  return {
    status: v.status as VerifyStatus,
    command: text(v.command),
    exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
  };
}

/** SELECTs only: no INSERT/UPDATE, no event, no lock beyond what the caller holds. */
export async function factoryTaskDetail(
  tx: PoolClient,
  task: Task,
  independent?: Independent,
): Promise<FactoryTaskDetail> {
  const { rows } = await tx.query<{ id: string; stage: FactoryCheckResult["stage"]; status: string; candidateId: string | null; candidateSha: string | null; runId: string | null; report: unknown }>(
    `SELECT a.id,a.stage,a.status,a."candidateId",c.sha AS "candidateSha",a."runId",r.report FROM factory_attempts a
       LEFT JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
       LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2
      WHERE a."taskId"=$1 AND a.stage IN ('review','verify','monitor') ORDER BY a.position`,
    [task.id, task.userId],
  );
  const checks: FactoryCheckResult[] = [];
  for (const row of rows) {
    if (!(FACTORY_STATUSES as readonly string[]).includes(row.status)) continue;
    checks.push({
      attemptId: row.id,
      stage: row.stage,
      status: row.status as FactoryStatus,
      candidateId: row.candidateId,
      candidateSha: row.candidateId ? row.candidateSha : null,
      runId: row.runId,
      independent: row.runId && independent ? await independent(tx, task as never, row.runId) : null,
      criteria: factoryCriteria(row.report),
      verify: verifyOf(row.report),
    });
  }
  const { rows: [d] } = await tx.query<{ sha: string | null; repository: string | null; environment: string | null; pullRequest: FactoryDelivery["pullRequest"]; previewUrl: string | null; deploymentEnvironment: string | null }>(
    `SELECT c.sha,c.repository,c.environment,
       (SELECT p."pullRequest" FROM run_publications p WHERE p."runId"=c."runId" AND p."userId"=$3) AS "pullRequest",
       (SELECT f.receipt->'verifiedTarget'->>'reference' FROM factory_publications f
         WHERE f."taskId"=$1 AND f."candidateId"=c.id AND f.status='succeeded' AND f.receipt->'verifiedTarget'->>'environment'='preview'
         ORDER BY f."finishedAt" DESC NULLS LAST, f.id DESC LIMIT 1) AS "previewUrl",
       (SELECT CASE WHEN f.receipt->'verifiedTarget'->'provider'->>'name'='vercel'
                    THEN f.receipt->'verifiedTarget'->'provider'->>'environment' END
          FROM factory_publications f
         WHERE f."taskId"=$1 AND f."candidateId"=c.id AND f.status='succeeded'
         ORDER BY f."finishedAt" DESC NULLS LAST, f.id DESC LIMIT 1) AS "deploymentEnvironment"
     FROM factory_candidates c WHERE c.id=$2 AND c."taskId"=$1`,
    [task.id, task.candidateId, task.userId],
  );
  const url = d?.previewUrl && d.previewUrl.startsWith("https://") ? d.previewUrl : null;
  return {
    checks,
    delivery: {
      candidateSha: d?.sha ?? null,
      repository: d?.repository ?? null,
      environment: d?.environment ?? null,
      pullRequest: d?.pullRequest ?? null,
      previewUrl: url,
      databaseBranch: null,
      deploymentEnvironment: d?.deploymentEnvironment === "preview" || d?.deploymentEnvironment === "production" ? d.deploymentEnvironment : null,
    },
  };
}
