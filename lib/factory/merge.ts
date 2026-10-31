import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { bindingSchema, FactoryError, type FactoryActor, type FactoryBinding } from "./approval-contract";
import type { FactoryApprovalStore, FactoryAuthorize, FactoryTask } from "./approval-dependencies";
import { approvalEvidence, digest } from "./evidence";

// #528: acceptance is the person's own merge of the candidate PR (Warp
// Factories). The person's GitHub App user-to-server token makes the call, so
// GitHub's branch protection, required checks and repository permissions
// decide; Mikka never merges with an app, installation or agent identity.

export const MERGE_REFUSALS = [
  "githubMergeAuthorizationRequired",
  "githubMergeForbidden",
  "githubMergeBlocked",
  "githubMergeConflict",
  "githubMergeHeadMoved",
  "githubMergeClosed",
  "githubUnavailable",
] as const;
export type MergeRefusal = (typeof MERGE_REFUSALS)[number];

/** A merge GitHub refused (or could not be asked for). The task keeps waiting for acceptance. */
export class FactoryMergeRefused extends Error {
  constructor(readonly code: MergeRefusal, readonly pullRequestUrl: string | null) {
    super(code);
  }
}

export type MergeMethod = "merge" | "squash" | "rebase";
export interface GitHubPullRequestView {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  mergeableState: string | null;
  mergeCommitSha: string | null;
}
/** GitHub, as the accepting person. Tests pass a fixture; production uses githubMergeApi. */
export interface GitHubMergePort {
  pullRequest(token: string, repo: string, number: number): Promise<GitHubPullRequestView>;
  mergeMethods(token: string, repo: string): Promise<MergeMethod[]>;
  /** `sha` binds the merge to the candidate commit: GitHub refuses it if the head moved. */
  merge(token: string, repo: string, number: number, input: { sha: string; method: MergeMethod }):
    Promise<{ merged: true; mergeCommitSha: string | null } | { merged: false; status: number }>;
}

export const acceptRequest = z.object({ binding: bindingSchema, eventId: z.uuid() }).strict();

const PULL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;
const STALE_MERGING_MS = 60_000;
/** `owner/repo` from a candidate's repository, given as a name or a GitHub URL. */
const repoName = (repository: string) =>
  repository.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();

function fail(code: string): never {
  throw new FactoryError(code);
}
const bindingOf = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});

/** Gate check for approval and publish: the named merge is this task's merged candidate. */
export async function mergedFor(tx: PoolClient, task: FactoryTask, mergeId: unknown) {
  if (typeof mergeId !== "string" || !z.uuid().safeParse(mergeId).success) return false;
  const { rows } = await tx.query(
    `SELECT 1 FROM factory_merges WHERE id=$1 AND "taskId"=$2 AND "candidateId"=$3 AND status='merged'`,
    [mergeId, task.id, task.candidateId],
  );
  return rows.length > 0;
}

/** Real GitHub REST calls with the person's token. */
export function githubMergeApi(fetcher: typeof fetch = fetch): GitHubMergePort {
  async function call(token: string, method: "GET" | "PUT", path: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Mikka",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FactoryMergeRefused("githubUnavailable", null);
    }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, data };
  }
  const refusedRead = (status: number): never => {
    if (status === 401) throw new FactoryMergeRefused("githubMergeAuthorizationRequired", null);
    if (status === 403 || status === 404) throw new FactoryMergeRefused("githubMergeForbidden", null);
    throw new FactoryMergeRefused("githubUnavailable", null);
  };
  return {
    async pullRequest(token, repo, number) {
      const { status, data } = await call(token, "GET", `/repos/${repo}/pulls/${number}`);
      if (status !== 200 || !data) return refusedRead(status);
      const head = data.head as { sha?: unknown } | undefined;
      if ((data.state !== "open" && data.state !== "closed") || typeof head?.sha !== "string")
        throw new FactoryMergeRefused("githubUnavailable", null);
      return {
        state: data.state,
        merged: data.merged === true,
        headSha: head.sha,
        mergeableState: typeof data.mergeable_state === "string" ? data.mergeable_state : null,
        mergeCommitSha: typeof data.merge_commit_sha === "string" ? data.merge_commit_sha : null,
      };
    },
    async mergeMethods(token, repo) {
      const { status, data } = await call(token, "GET", `/repos/${repo}`);
      if (status !== 200 || !data) return refusedRead(status);
      const methods: MergeMethod[] = [];
      if (data.allow_merge_commit !== false) methods.push("merge");
      if (data.allow_squash_merge !== false) methods.push("squash");
      if (data.allow_rebase_merge !== false) methods.push("rebase");
      return methods;
    },
    async merge(token, repo, number, input) {
      const { status, data } = await call(token, "PUT", `/repos/${repo}/pulls/${number}/merge`, {
        sha: input.sha,
        merge_method: input.method,
      });
      if (status === 200 && data?.merged === true)
        return { merged: true, mergeCommitSha: typeof data.sha === "string" ? data.sha : null };
      return { merged: false, status };
    },
  };
}

/** GitHub's refusal of PUT /merge, as a stable code. */
function refusalFor(status: number, mergeableState: string | null): MergeRefusal {
  if (status === 401) return "githubMergeAuthorizationRequired";
  if (status === 403 || status === 404) return "githubMergeForbidden";
  if (status === 409) return "githubMergeHeadMoved";
  if (status === 405 || status === 422) return mergeableState === "dirty" ? "githubMergeConflict" : "githubMergeBlocked";
  return "githubUnavailable";
}

export type AcceptResult =
  | { status: "merged"; mergeId: string; pullRequestUrl: string; binding: FactoryBinding }
  | { status: "merging"; mergeId: string; pullRequestUrl: string };

export function createFactoryMerges(
  pool: Pool,
  authorize: FactoryAuthorize,
  store: FactoryApprovalStore,
  github: GitHubMergePort,
) {
  async function transaction<T>(fn: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }

  /** The current candidate's PR, from the run that produced it. */
  async function candidatePull(tx: PoolClient, task: FactoryTask) {
    const {
      rows: [row],
    } = await tx.query<{ sha: string; repository: string; url: string | null; skill: boolean }>(
      `SELECT c.sha,c.repository,p."pullRequest"->>'url' AS url,
              EXISTS (SELECT 1 FROM improvement_skill_candidates s WHERE s."factoryTaskId"=c."taskId" AND s."candidateId"=c.id AND s."userId"=$3) AS skill
         FROM factory_candidates c LEFT JOIN run_publications p ON p."runId"=c."runId" AND p."userId"=$3
        WHERE c.id=$1 AND c."taskId"=$2`,
      [task.candidateId, task.id, task.userId],
    );
    if (!row) fail("factoryTransition");
    if (row.skill) fail("factoryAcceptanceIsSkill");
    const match = row.url ? PULL.exec(row.url) : null;
    if (!match) fail("factoryPullRequestMissing");
    if (match[1].toLowerCase() !== repoName(row.repository)) fail("factoryEvidenceMismatch");
    return { sha: row.sha, url: row.url!, repo: match[1], number: Number(match[2]) };
  }

  /** Approval passes, then publish passes: the task is complete. Both gates check the merged row. */
  async function finalize(tx: PoolClient, task: FactoryTask, mergeId: string) {
    if (task.stage !== "approval" || !["pending", "waiting"].includes(task.status)) return task;
    const current = await approvalEvidence(tx, task);
    const reason = "The person merged the candidate pull request";
    let result = await store.apply(task.userId, bindingOf(task), randomUUID(),
      { action: "finish", status: "passed", reason, evidence: current.evidence, output: { mergeId } }, tx);
    result = await store.apply(task.userId, bindingOf(result.task), randomUUID(),
      { action: "advance", stage: "publish", reason }, tx);
    result = await store.apply(task.userId, bindingOf(result.task), randomUUID(),
      { action: "finish", status: "passed", reason, evidence: current.evidence, output: { mergeId } }, tx);
    return result.task;
  }

  /** Records GitHub's answer for a merge this request started, completing the task on success. */
  async function settle(
    actor: FactoryActor,
    mergeId: string,
    outcome: { merged: true; headSha: string | null; mergeCommitSha: string | null } | { merged: false; code: MergeRefusal },
    pullRequestUrl: string,
  ): Promise<AcceptResult> {
    if (!outcome.merged) {
      await pool.query(
        `UPDATE factory_merges SET status='failed',code=$2,"finishedAt"=clock_timestamp() WHERE id=$1 AND status='merging'`,
        [mergeId, outcome.code],
      );
      throw new FactoryMergeRefused(outcome.code, pullRequestUrl);
    }
    return transaction(async (tx) => {
      const {
        rows: [row],
      } = await tx.query(`SELECT "taskId" FROM factory_merges WHERE id=$1`, [mergeId]);
      const task = await store.lockTask(tx, actor.userId, row.taskId);
      await tx.query(
        `UPDATE factory_merges SET status='merged',"headSha"=$2,"mergeCommitSha"=$3,"finishedAt"=clock_timestamp() WHERE id=$1 AND status='merging'`,
        [mergeId, outcome.headSha, outcome.mergeCommitSha],
      );
      // The candidate card's PR reads merged at once, not only after the webhook.
      await tx.query(
        `UPDATE run_publications SET "pullRequest"=jsonb_set("pullRequest",'{state}','"merged"') WHERE lower("pullRequest"->>'url')=lower($1)`,
        [pullRequestUrl],
      );
      const done = await finalize(tx, task, mergeId);
      return { status: "merged", mergeId, pullRequestUrl, binding: bindingOf(done) };
    });
  }

  return {
    /** 验收并合并. `token` is the person's own GitHub user token, or null when none is linked. */
    async accept(actor: FactoryActor, input: unknown, token: string | null): Promise<AcceptResult> {
      const parsed = acceptRequest.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const req = parsed.data;
      if (!actor?.userId || !actor.sessionId) fail("factoryHumanRequired");
      const claim = await transaction(async (tx) => {
        const task = await store.lockTask(tx, actor.userId, req.binding.taskId);
        if (!task || !(await authorize(actor.userId, task.issueId, tx))) fail("factoryNotFound");
        const { rows: live } = await tx.query(
          `SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE`,
          [actor.sessionId, actor.userId],
        );
        if (!live.length) fail("factoryHumanRequired");
        const {
          rows: [replay],
        } = await tx.query(`SELECT * FROM factory_merges WHERE "taskId"=$1 AND "eventId"=$2`, [task.id, req.eventId]);
        if (replay) {
          if (replay.userId !== actor.userId) fail("factoryReplayMismatch");
          if (replay.status === "failed") throw new FactoryMergeRefused(replay.code, replay.pullRequestUrl);
          return { existing: replay, task };
        }
        if (["cancelled", "revoked"].includes(task.status)) fail("factoryStopped");
        // A double click, or a merge already in flight or done: never a second merge call.
        const {
          rows: [active],
        } = await tx.query(
          `SELECT * FROM factory_merges WHERE "taskId"=$1 AND "candidateId"=$2 AND status IN ('merging','merged') FOR UPDATE`,
          [task.id, task.candidateId],
        );
        if (active) return { existing: active, task };
        if (digest(bindingOf(task)) !== digest(req.binding)) fail("factoryStale");
        if (task.stage !== "approval" || !["pending", "waiting"].includes(task.status)) fail("factoryTransition");
        const pull = await candidatePull(tx, task);
        if (!token) throw new FactoryMergeRefused("githubMergeAuthorizationRequired", pull.url);
        const id = randomUUID();
        await tx.query(
          `INSERT INTO factory_merges (id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,'merging','mikka')`,
          [id, task.id, task.candidateId, actor.userId, req.eventId, pull.url, pull.sha],
        );
        return { id, pull };
      });

      if ("existing" in claim) {
        const row = claim.existing;
        if (row.status === "merged")
          return { status: "merged", mergeId: row.id, pullRequestUrl: row.pullRequestUrl, binding: bindingOf(claim.task!) };
        // Another request is merging. Only a stale claim is re-read from GitHub, and never merged again.
        if (!token || Date.now() - new Date(row.createdAt).getTime() < STALE_MERGING_MS)
          return { status: "merging", mergeId: row.id, pullRequestUrl: row.pullRequestUrl };
        const match = PULL.exec(row.pullRequestUrl)!;
        const view = await github.pullRequest(token, match[1], Number(match[2])).catch(() => null);
        if (!view) return { status: "merging", mergeId: row.id, pullRequestUrl: row.pullRequestUrl };
        return settle(actor, row.id,
          view.merged ? { merged: true, headSha: view.headSha, mergeCommitSha: view.mergeCommitSha } : { merged: false, code: "githubUnavailable" },
          row.pullRequestUrl);
      }

      const { id, pull } = claim;
      let view: GitHubPullRequestView;
      try {
        view = await github.pullRequest(token!, pull.repo, pull.number);
      } catch (error) {
        return settle(actor, id, { merged: false, code: error instanceof FactoryMergeRefused ? error.code : "githubUnavailable" }, pull.url);
      }
      if (view.merged) return settle(actor, id, { merged: true, headSha: view.headSha, mergeCommitSha: view.mergeCommitSha }, pull.url);
      if (view.state === "closed") return settle(actor, id, { merged: false, code: "githubMergeClosed" }, pull.url);
      if (view.headSha !== pull.sha) return settle(actor, id, { merged: false, code: "githubMergeHeadMoved" }, pull.url);
      if (view.mergeableState === "dirty") return settle(actor, id, { merged: false, code: "githubMergeConflict" }, pull.url);
      let result: Awaited<ReturnType<GitHubMergePort["merge"]>>;
      try {
        const methods = await github.mergeMethods(token!, pull.repo);
        if (!methods.length) return settle(actor, id, { merged: false, code: "githubMergeBlocked" }, pull.url);
        result = await github.merge(token!, pull.repo, pull.number, { sha: pull.sha, method: methods[0] });
      } catch (error) {
        if (error instanceof FactoryMergeRefused && error.code !== "githubUnavailable")
          return settle(actor, id, { merged: false, code: error.code }, pull.url);
        // The outcome is unknown: read it back rather than guess.
        const after = await github.pullRequest(token!, pull.repo, pull.number).catch(() => null);
        if (!after) return { status: "merging", mergeId: id, pullRequestUrl: pull.url };
        return settle(actor, id,
          after.merged ? { merged: true, headSha: after.headSha, mergeCommitSha: after.mergeCommitSha } : { merged: false, code: "githubUnavailable" },
          pull.url);
      }
      if (result.merged) return settle(actor, id, { merged: true, headSha: pull.sha, mergeCommitSha: result.mergeCommitSha }, pull.url);
      return settle(actor, id, { merged: false, code: refusalFor(result.status, view.mergeableState) }, pull.url);
    },

    /** A verified `pull_request` closed+merged webhook: completes every task waiting on that PR, including merges made on GitHub. */
    async pullRequestMerged(input: { url: string; headSha: string | null; mergeCommitSha: string | null }) {
      if (!PULL.test(input.url)) return { completed: 0 };
      await pool.query(
        `UPDATE run_publications SET "pullRequest"=jsonb_set("pullRequest",'{state}','"merged"') WHERE lower("pullRequest"->>'url')=lower($1)`,
        [input.url],
      );
      const { rows: waiting } = await pool.query<{ id: string; userId: string }>(
        `SELECT t.id,t."userId" FROM factory_tasks t
           JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
           JOIN run_publications p ON p."runId"=c."runId" AND p."userId"=t."userId"
          WHERE lower(p."pullRequest"->>'url')=lower($1) AND t.stage='approval' AND t.status IN ('pending','waiting')`,
        [input.url],
      );
      let completed = 0;
      for (const { id, userId } of waiting) {
        await transaction(async (tx) => {
          const task = await store.lockTask(tx, userId, id);
          if (!task || task.stage !== "approval" || !["pending", "waiting"].includes(task.status)) return;
          const pull = await candidatePull(tx, task).catch(() => null);
          if (!pull || pull.url.toLowerCase() !== input.url.toLowerCase()) return;
          const {
            rows: [active],
          } = await tx.query(
            `SELECT id,status FROM factory_merges WHERE "taskId"=$1 AND "candidateId"=$2 AND status IN ('merging','merged') FOR UPDATE`,
            [task.id, task.candidateId],
          );
          let mergeId = active?.id as string | undefined;
          if (active?.status === "merging")
            await tx.query(
              `UPDATE factory_merges SET status='merged',"headSha"=$2,"mergeCommitSha"=$3,"finishedAt"=clock_timestamp() WHERE id=$1`,
              [mergeId, input.headSha, input.mergeCommitSha],
            );
          if (!mergeId) {
            mergeId = randomUUID();
            // Merged on GitHub. headSha records what was merged, which may differ from the reviewed candidate.
            await tx.query(
              `INSERT INTO factory_merges (id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source,"headSha","mergeCommitSha","finishedAt")
               VALUES ($1,$2,$3,$4,$5,$6,$7,'merged','github',$8,$9,clock_timestamp())`,
              [mergeId, task.id, task.candidateId, task.userId, randomUUID(), pull.url, pull.sha, input.headSha, input.mergeCommitSha],
            );
          }
          await finalize(tx, task, mergeId);
          completed++;
        });
      }
      return { completed };
    },
  };
}
