import "server-only";
import {
  FactoryMergeRefused,
  githubMergeApi,
  refusalFor,
  type GitHubMergePort,
} from "../factory/merge";
import { githubTokenForUser, GitHubAccessError } from "./user-access";
import { readPullDetail } from "./pull-detail";
import type { RequestBudget } from "../request-budget";
import {
  pullMergeInput,
  type PullDetail,
  type PullMergeInput,
  type PullMergeResult,
} from "../pull-directory";

export type PullMergeDependencies = {
  /** The admitted-repository read: the same gate as the directory and the PR page. */
  detail: (userId: string, repo: string, number: number) => Promise<PullDetail>;
  /** The person's own GitHub user-to-server token: Mikka never merges as an app or an agent. */
  userToken: (userId: string) => Promise<string>;
  github: GitHubMergePort;
};

export function pullMergeDependencies(
  budget: RequestBudget,
): PullMergeDependencies {
  return {
    detail: (userId, repo, number) =>
      readPullDetail(userId, repo, number, budget),
    userToken: async (userId) =>
      (await githubTokenForUser(userId, { budget })).token,
    github: githubMergeApi(fetch, budget),
  };
}

/**
 * Merges one pull request by itself, for PRs with or without a task (S3). The rules are the
 * task review's (lib/coding-workspace/task-review/merge.ts): only a signed-in person, as
 * themselves, with their own GitHub token, so branch protection, required checks and their
 * repository permission decide; bound to the head they looked at; failing checks need the
 * person's explicit go-ahead. A merged task PR reaches its task through the webhook, as an
 * outside merge always has.
 */
export async function mergePullRequest(
  userId: string,
  raw: PullMergeInput,
  deps: PullMergeDependencies,
): Promise<PullMergeResult> {
  const input = pullMergeInput.parse(raw);
  const detail = await deps.detail(userId, input.repo, input.number);
  if (detail.state === "merged") return { kind: "merged", mergeCommitSha: null };
  if (detail.state === "closed")
    return { kind: "refused", code: "githubMergeClosed" };
  if (detail.headSha !== input.expectedHeadSha)
    return { kind: "refused", code: "githubMergeHeadMoved" };
  const failing = detail.checkRuns.filter(
    (check) => check.state === "failure",
  ).length;
  if (failing && !input.confirmFailedChecks)
    return { kind: "needs_confirm", failing };
  try {
    let token: string;
    try {
      token = await deps.userToken(userId);
    } catch (error) {
      if (error instanceof GitHubAccessError)
        return { kind: "refused", code: "githubMergeAuthorizationRequired" };
      throw error;
    }
    const repo = detail.repo;
    const pull = await deps.github.pullRequest(token, repo, input.number);
    if (pull.merged) return { kind: "merged", mergeCommitSha: pull.mergeCommitSha };
    if (pull.state !== "open")
      return { kind: "refused", code: "githubMergeClosed" };
    if (pull.headSha.toLowerCase() !== input.expectedHeadSha)
      return { kind: "refused", code: "githubMergeHeadMoved" };
    const methods = await deps.github.mergeMethods(token, repo);
    const method =
      input.method && methods.includes(input.method)
        ? input.method
        : methods[0];
    if (!method) return { kind: "refused", code: "githubMergeBlocked" };
    let merged: Awaited<ReturnType<GitHubMergePort["merge"]>>;
    try {
      merged = await deps.github.merge(token, repo, input.number, {
        sha: input.expectedHeadSha,
        method,
      });
    } catch (error) {
      // The answer can be lost after GitHub merged (a timeout, a reset): read the PR once more
      // before calling it a failure. Only this head merged counts as this merge.
      const after = await deps.github
        .pullRequest(token, repo, input.number)
        .catch(() => null);
      if (after?.merged && after.headSha.toLowerCase() === input.expectedHeadSha)
        return { kind: "merged", mergeCommitSha: after.mergeCommitSha };
      throw error;
    }
    return merged.merged
      ? { kind: "merged", mergeCommitSha: merged.mergeCommitSha }
      : { kind: "refused", code: refusalFor(merged.status, pull.mergeableState) };
  } catch (error) {
    if (error instanceof FactoryMergeRefused)
      return { kind: "refused", code: error.code };
    throw error;
  }
}
