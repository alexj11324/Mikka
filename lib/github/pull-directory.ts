import "server-only";
import { z } from "zod";
import {
  githubRepositoryReadCredential,
  GitHubAccessError,
} from "./user-access";
import { requestBudgetSignal, type RequestBudget } from "../request-budget";
import { pullPageInput, type PullDirectoryPage } from "../pull-directory";

const query = `query PullDirectory($owner: String!, $name: String!, $after: String, $states: [PullRequestState!]) {
  repository(owner: $owner, name: $name) { databaseId nameWithOwner pullRequests(first: 20, after: $after, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { number title bodyText state isDraft createdAt updatedAt additions deletions headRefName baseRefName headRefOid mergeStateStatus reviewDecision
      author { login avatarUrl } labels(first: 100) { nodes { name } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
    }
  } }
}`;
const date = z.string().datetime({ offset: true });
const pull = z.object({
  number: z.number().int().positive().refine(Number.isSafeInteger),
  title: z.string().max(1000),
  bodyText: z.string().max(200000),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  createdAt: date,
  updatedAt: date,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  author: z
    .object({ login: z.string(), avatarUrl: z.string().url() })
    .nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })).max(100) }),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            oid: z.string(),
            statusCheckRollup: z
              .object({
                state: z.enum([
                  "SUCCESS",
                  "PENDING",
                  "FAILURE",
                  "ERROR",
                  "EXPECTED",
                ]),
              })
              .nullable(),
          }),
        }),
      )
      .max(1),
  }),
});
const result = z.object({
  data: z.object({
    repository: z.object({
      databaseId: z.number().int().positive(),
      nameWithOwner: z.string(),
      pullRequests: z.object({
        totalCount: z.number().int().nonnegative(),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(pull).max(20),
      }),
    }),
  }),
});

/** Same admitted user/App repository intersection as branch browsing. Never read arbitrary GitHub URLs or use a workspace peer's token. */
export async function repositoryPullDirectory(
  userId: string,
  input: z.input<typeof pullPageInput>,
  budget: RequestBudget,
): Promise<PullDirectoryPage> {
  const { repo, view, cursor, since } = pullPageInput.parse(input);
  const access = await githubRepositoryReadCredential(
    userId,
    "v2/github.com/" + repo.toLowerCase(),
    budget,
  );
  const [owner, name] = access.repository.fullName.split("/");
  const raw = await githubGraphql(access.token, budget, query, {
    owner,
    name,
    after: cursor,
    states:
      view === "merged"
        ? ["MERGED"]
        : view === "all"
          ? ["OPEN", "CLOSED", "MERGED"]
          : ["OPEN"],
  });
  const parsed = result.safeParse(raw);
  if (!parsed.success) throw new GitHubAccessError("githubUnavailable", 502);
  const repository = parsed.data.data.repository;
  if (
    String(repository.databaseId) !== access.repository.id ||
    repository.nameWithOwner.toLowerCase() !==
      access.repository.fullName.toLowerCase()
  )
    throw new GitHubAccessError("githubRepositoryForbidden", 403);
  const page = repository.pullRequests;
  if (
    page.pageInfo.hasNextPage &&
    (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor)
  )
    throw new GitHubAccessError("githubUnavailable", 502);
  // Pages run newest update first and a PR is never updated before it opens:
  // once a page reaches an update older than `since`, no later page can match.
  const floor = since ? Date.parse(since) : null;
  const exhausted =
    floor !== null &&
    page.nodes.some((row) => Date.parse(row.updatedAt) < floor);
  return {
    total: page.totalCount,
    cursor:
      page.pageInfo.hasNextPage && !exhausted ? page.pageInfo.endCursor : null,
    items: page.nodes.filter((row) => floor === null || Date.parse(row.createdAt) >= floor).map((row) => {
      const commit = row.commits.nodes[0]?.commit;
      const avatar = row.author?.avatarUrl;
      return {
        url: `https://github.com/${repository.nameWithOwner}/pull/${row.number}`,
        repo: repository.nameWithOwner,
        number: row.number,
        title: row.title,
        state:
          row.state === "MERGED"
            ? "merged"
            : row.state === "CLOSED"
              ? "closed"
              : row.isDraft
                ? "draft"
                : "open",
        author: row.author?.login ?? null,
        authorAvatar: avatar?.startsWith(
          "https://avatars.githubusercontent.com/",
        )
          ? avatar
          : null,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
        body: row.bodyText,
        head: row.headRefName,
        base: row.baseRefName,
        headSha: row.headRefOid,
        checks:
          commit?.oid === row.headRefOid
            ? (commit.statusCheckRollup?.state ?? null)
            : null,
        mergeState: row.mergeStateStatus,
        reviewDecision: row.reviewDecision,
        additions: row.additions,
        deletions: row.deletions,
        labels: row.labels.nodes.map((label) => label.name),
        threads: [],
      };
    }),
  };
}

/**
 * One GitHub GraphQL read with the given credential. Every failure is the same
 * coded refusal: provider bodies, parse errors and network errors can carry
 * private source or the credential, so none of them leave as a cause.
 */
export async function githubGraphql(
  token: string,
  budget: RequestBudget,
  graphql: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: requestBudgetSignal(budget),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "Mikka",
      },
      body: JSON.stringify({ query: graphql, variables }),
    });
  } catch {
    // error-cause: network errors may contain the credential-bearing request.
    throw new GitHubAccessError("githubUnavailable", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubAccessError(
      response.status === 401
        ? "githubReconnectRequired"
        : response.status === 403
          ? "githubRepositoryForbidden"
          : "githubUnavailable",
      response.status === 401 ? 401 : response.status === 403 ? 403 : 502,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GitHubAccessError("githubUnavailable", 502);
  let raw: unknown;
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("tooLarge");
      chunks.push(item.value);
    }
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {});
    // error-cause: provider bodies and parsing errors can include private source or credentials.
    throw new GitHubAccessError("githubUnavailable", 502);
  } finally {
    reader.releaseLock();
  }
  // A partial GraphQL response is not a complete answer or a successful empty one.
  if (raw && typeof raw === "object" && "errors" in raw)
    throw new GitHubAccessError("githubUnavailable", 502);
  return raw;
}
