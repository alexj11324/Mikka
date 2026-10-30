import type { PoolClient } from "pg";
import { redactFactoryCheckText } from "./checks";

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
  status: string;
  runId: string | null;
  /** true/false = ancestry predicate result; null = no run yet. */
  independent: boolean | null;
  criteria: FactoryCheckCriterion[];
  verify: { status: string; command: string | null; exitCode: number | null } | null;
}
/** B11 header (the rest of #445's list fields, on the detail). */
export interface FactoryDelivery {
  candidateSha: string | null;
  pullRequest: { url: string; state: "open" | "draft" | "merged" | "closed" } | null;
  previewUrl: string | null;
}
export interface FactoryTaskDetail { checks: FactoryCheckResult[]; delivery: FactoryDelivery }
type Task = { id: string; issueId: string; candidateId: string | null; userId: string };
type Independent = (tx: PoolClient, task: never, runId: string) => Promise<boolean>;

const text = (v: unknown) => (typeof v === "string" && v.trim() ? redactFactoryCheckText(v) : null);

export function factoryCriteria(report: unknown): FactoryCheckCriterion[] {
  const list = (report as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 200).flatMap((c) =>
    c && typeof c === "object" && typeof (c as { passed?: unknown }).passed === "boolean"
      ? [{
          criterionId: typeof (c as { criterionId?: unknown }).criterionId === "string" ? (c as { criterionId: string }).criterionId : null,
          text: text((c as { text?: unknown }).text),
          passed: (c as { passed: boolean }).passed,
          evidence: text((c as { evidence?: unknown }).evidence),
        }]
      : [],
  );
}
function verifyOf(report: unknown): FactoryCheckResult["verify"] {
  const v = (report as { verify?: Record<string, unknown> } | null)?.verify;
  if (!v || typeof v.status !== "string") return null;
  return {
    status: v.status,
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
  const { rows } = await tx.query<{ id: string; stage: FactoryCheckResult["stage"]; status: string; runId: string | null; report: unknown }>(
    `SELECT a.id,a.stage,a.status,a."runId",r.report FROM factory_attempts a
       LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2
      WHERE a."taskId"=$1 AND a.stage IN ('review','verify','monitor') ORDER BY a.position`,
    [task.id, task.userId],
  );
  const checks: FactoryCheckResult[] = [];
  for (const row of rows)
    checks.push({
      attemptId: row.id,
      stage: row.stage,
      status: row.status,
      runId: row.runId,
      independent: row.runId && independent ? await independent(tx, task as never, row.runId) : null,
      criteria: factoryCriteria(row.report),
      verify: verifyOf(row.report),
    });
  const { rows: [d] } = await tx.query<{ sha: string | null; pullRequest: FactoryDelivery["pullRequest"]; previewUrl: string | null }>(
    `SELECT c.sha,
       (SELECT p."pullRequest" FROM run_publications p WHERE p."runId"=c."runId" AND p."userId"=$3) AS "pullRequest",
       (SELECT f.receipt->'verifiedTarget'->>'reference' FROM factory_publications f
         WHERE f."taskId"=$1 AND f."candidateId"=c.id AND f.status='succeeded' AND f.receipt->'verifiedTarget'->>'environment'='preview'
         ORDER BY f."finishedAt" DESC NULLS LAST, f.id DESC LIMIT 1) AS "previewUrl"
     FROM factory_candidates c WHERE c.id=$2 AND c."taskId"=$1`,
    [task.id, task.candidateId, task.userId],
  );
  const url = d?.previewUrl && d.previewUrl.startsWith("https://") ? d.previewUrl : null;
  return {
    checks,
    delivery: { candidateSha: d?.sha ?? null, pullRequest: d?.pullRequest ?? null, previewUrl: url },
  };
}
