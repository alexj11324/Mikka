import type { PoolClient } from "pg";
import { factoryDecisionWarnings, type ProjectDecisionWarning } from "../project-decision-warnings";
import { VERIFY_STATUSES, criterionVerificationStatus, runCriterion, type CriterionStatus, type VerifyStatus } from "@mikka/protocol/run";
import { redactFactoryCheckText } from "./checks";
import { FACTORY_STATUSES, type FactoryStatus } from "./contract";
import { citedQuestionCommandSources, type QuestionCommandOrigin } from "./question-command-sources";

/** B8/B9 (Figma 357:4750): one row per review/verify/monitor attempt. Read-only. */
export interface FactoryCheckCriterion {
  criterionId: string | null;
  text: string | null;
  passed: boolean;
  status: CriterionStatus;
  reason: string | null;
  evidence: string | null;
  command: string | null;
  exitCode: number | null;
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
  criteria: FactoryCheckCriterion[];
  commandSources?: QuestionCommandOrigin[];
  /** null when the run has no report, or report.verify.status is not one of VERIFY_STATUSES. command is null when the report has none. */
  verify: { status: VerifyStatus; command: string | null; exitCode: number | null } | null;
}
/** B11 header (the rest of #445's list fields, on the detail). */
export interface FactoryDelivery {
  candidateSha: string | null;
  previewDatabaseBranch: string | null;
  machineName: string | null;
  pullRequest: { url: string; title?: string; state: "open" | "draft" | "merged" | "closed" } | null;
  /** factory_candidates.repository of the current candidate (e.g. "owner/repo"). */
  repository: string | null;
  /** factory_candidates.environment: where the candidate was built (e.g. "device:<id>"), not a deploy target. */
  environment: string | null;
  /**
   * Same row as deploymentEnvironment: the newest succeeded publication of the current candidate.
   * previewUrl is that row's receipt.verifiedTarget.reference (provider-confirmed), kept only when it
   * is https; otherwise null (no fallback to an older row).
   * Despite the name, this is the URL of the latest successful publication, which may be a preview
   * or a production deployment; deploymentEnvironment tells them apart. The name is kept because
   * Frontend already reads it.
   */
  previewUrl: string | null;
  /**
   * Vercel's deployment target as recorded in receipt.verifiedTarget.provider.environment (provider
   * name "vercel") of the same row as previewUrl: the newest succeeded publication of the current candidate. Any other value, a
   * receipt without a Vercel provider, or no receipt gives null. Never inferred from branch names.
   */
  deploymentEnvironment: "preview" | "production" | null;
  /** The PR's head and base branch, as the publication recorded them; null before there is one. */
  branch: { head: string; base: string | null } | null;
  /** The owner's connected GitHub login: the account 批准并合并 merges as. null when none is connected. */
  mergeAs: string | null;
  /** The candidate run's own one-paragraph summary of its change, redacted and bounded. */
  summary: string | null;
}
export interface FactoryTaskDetail { checks: FactoryCheckResult[]; delivery: FactoryDelivery; decisionWarnings: ProjectDecisionWarning[] }
type Task = { id: string; issueId: string; candidateId: string | null; userId: string };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? redactFactoryCheckText(v) : null);

export function factoryCriteria(report: unknown): FactoryCheckCriterion[] {
  const fallback = verifyOf(report);
  const list = (report as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(list)) return [];
  // Filter first, then cap, so malformed entries never take one of the 200 slots.
  return list.flatMap((c) =>
    c && typeof c === "object" && typeof (c as { passed?: unknown }).passed === "boolean"
      ? [{
          criterionId: typeof (c as { criterionId?: unknown }).criterionId === "string" ? (c as { criterionId: string }).criterionId : null,
          text: text((c as { text?: unknown }).text),
          passed: (c as { passed: boolean }).passed,
          status: runCriterion.safeParse(c).success ? criterionVerificationStatus(runCriterion.parse(c)) : "unverified",
          reason: text((c as { reason?: unknown }).reason),
          evidence: text((c as { evidence?: unknown }).evidence),
          command: text((c as { command?: unknown }).command) ?? fallback?.command ?? null,
          exitCode: text((c as { command?: unknown }).command) ? (Number.isSafeInteger((c as { exitCode?: unknown }).exitCode) ? (c as { exitCode: number }).exitCode : null) : fallback?.exitCode ?? null,
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
): Promise<FactoryTaskDetail> {
  const { rows } = await tx.query<{ id: string; stage: FactoryCheckResult["stage"]; status: string; candidateId: string | null; candidateSha: string | null; runId: string | null; report: unknown; check: unknown }>(
    `SELECT a.id,a.stage,a.status,a."candidateId",c.sha AS "candidateSha",a."runId",
            jsonb_build_object('criteria',r.report->'criteria','verify',jsonb_build_object(
              'status',r.report#>'{verify,status}','command',r.report#>'{verify,command}',
              'exitCode',r.report#>'{verify,exitCode}')) AS report,
            a.output->'check' AS check FROM factory_attempts a
       LEFT JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
       LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2
      WHERE a."taskId"=$1 AND a.stage IN ('review','verify','monitor') ORDER BY a.position`,
    [task.id, task.userId],
  );
  const checks: FactoryCheckResult[] = [];
  for (const row of rows) {
    if (!(FACTORY_STATUSES as readonly string[]).includes(row.status)) continue;
    const criteria = factoryCriteria(row.report);
    const commandSources = citedQuestionCommandSources(row.check, criteria, row.candidateId, row.candidateSha);
    checks.push({
      attemptId: row.id,
      stage: row.stage,
      status: row.status as FactoryStatus,
      candidateId: row.candidateId,
      candidateSha: row.candidateId ? row.candidateSha : null,
      runId: row.runId,
      criteria,
      ...(commandSources.length ? { commandSources } : {}),
      verify: verifyOf(row.report),
    });
  }
  const { rows: [d] } = await tx.query<{ sha: string | null; repository: string | null; environment: string | null; previewDatabaseBranch: string | null; machineName: string | null; pullRequest: FactoryDelivery["pullRequest"]; head: string | null; base: string | null; mergeAs: string | null; summary: string | null; previewUrl: string | null; deploymentEnvironment: string | null }>(
    `SELECT c.sha,c.repository,c.environment,c."previewDatabaseBranch",c."machineName",
       p."pullRequest",p.branch AS head,p."baseBranch" AS base,left(r.report->>'summary',2000) AS summary,
       (SELECT g."githubLogin" FROM github_connections g WHERE g."userId"=$3) AS "mergeAs",
       f.receipt->'verifiedTarget'->>'reference' AS "previewUrl",
       CASE WHEN f.receipt->'verifiedTarget'->'provider'->>'name'='vercel'
            THEN f.receipt->'verifiedTarget'->'provider'->>'environment' END AS "deploymentEnvironment"
     FROM factory_candidates c
     LEFT JOIN run_publications p ON p."runId"=c."runId" AND p."userId"=$3
     LEFT JOIN agent_runs r ON r.id=c."runId" AND r."userId"=$3
     LEFT JOIN LATERAL (SELECT receipt FROM factory_publications f
         WHERE f."taskId"=$1 AND f."candidateId"=c.id AND f.status='succeeded'
         ORDER BY f."finishedAt" DESC NULLS LAST, f.id DESC LIMIT 1) f ON true
     WHERE c.id=$2 AND c."taskId"=$1`,
    [task.id, task.candidateId, task.userId],
  );
  const url = d?.previewUrl && d.previewUrl.startsWith("https://") ? d.previewUrl : null;
  return {
    checks,
    decisionWarnings: await factoryDecisionWarnings(tx, task),
    delivery: {
      candidateSha: d?.sha ?? null,
      previewDatabaseBranch: text(d?.previewDatabaseBranch),
      machineName: text(d?.machineName),
      repository: d?.repository ?? null,
      environment: d?.environment ?? null,
      pullRequest: d?.pullRequest ?? null,
      previewUrl: url,
      deploymentEnvironment: d?.deploymentEnvironment === "preview" || d?.deploymentEnvironment === "production" ? d.deploymentEnvironment : null,
      branch: d?.head ? { head: d.head, base: d.base ?? null } : null,
      mergeAs: d?.mergeAs ?? null,
      summary: text(d?.summary),
    },
  };
}
