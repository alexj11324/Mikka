import { z } from "zod";
import type { IssuePullRequest } from "./issue-metadata";
import { githubPullRequestKey } from "./issue-metadata";
import type { ConversationDirectoryPage } from "./conversation-directory-input";

export const pullViews = ["open", "ready", "merged", "all"] as const;
export const pullGroups = ["state", "repo", "author", "none"] as const;
/** One vocabulary for the row's verdict, the group a row lands in and the state
 *  filter: `attention` is the coarse one — failing checks, a review that asked
 *  for changes, or a base it cannot merge into. */
export const pullStates = [
  "ready",
  "attention",
  "pending",
  "open",
  "draft",
  "merged",
  "closed",
] as const;
export type PullView = (typeof pullViews)[number];
export type PullGroup = (typeof pullGroups)[number];
export type PullState = (typeof pullStates)[number];
export type PullDirectoryRow = IssuePullRequest & {
  repo: string;
  number: number;
  author: string | null;
  authorAvatar: string | null;
  updatedAt: string;
  createdAt: string | null;
  body: string | null;
  head: string | null;
  base: string | null;
  headSha: string | null;
  checks: "SUCCESS" | "PENDING" | "FAILURE" | "ERROR" | "EXPECTED" | null;
  mergeState: string | null;
  reviewDecision: string | null;
  labels: string[];
  threads: ConversationDirectoryPage["items"];
};
export type PullDirectoryPage = {
  items: PullDirectoryRow[];
  cursor: string | null;
  total: number;
};
export const pullPageInput = z.strictObject({
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .refine(
      (value) =>
        value.split("/").every((part) => part !== "." && part !== ".."),
      "invalid repository",
    )
    .max(200),
  cursor: z.string().min(1).max(1024).nullable().default(null),
  view: z.enum(pullViews).default("open"),
  /** Only pull requests opened at or after this instant. */
  since: z.iso.datetime({ offset: true }).nullable().default(null),
});

/** The query for one pull request's changed files (app/api/integrations/github/repositories/pulls/files). */
export const pullFilesQuery = z.strictObject({
  repo: pullPageInput.shape.repo,
  number: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .refine((value) => Number.isSafeInteger(Number(value)), "invalid number"),
});

/**
 * A row's pull request as the review page opens it: `repo` holds `owner/name` on
 * the row, and the page needs the two halves apart. Null when the row does not
 * name a repository, so nothing offers a review it cannot read.
 */
export function pullReviewRef(
  pull: Pick<PullDirectoryRow, "repo" | "number">,
): { owner: string; repo: string; number: number } | null {
  const [owner, name, ...rest] = pull.repo.split("/");
  if (!owner || !name || rest.length) return null;
  return { owner, repo: name, number: pull.number };
}

/**
 * What a row is waiting on, in the words the page groups by. A pull request
 * needs a person when something is red — failing checks, a review that asked
 * for changes, a base GitHub will not merge into — before it is merely open;
 * `ready` is GitHub's own verdict (a clean merge state, nobody asking for
 * changes), never a green check alone.
 */
export function pullDirectoryState(pull: PullDirectoryRow): PullState {
  if (
    pull.state === "merged" ||
    pull.state === "closed" ||
    pull.state === "draft"
  )
    return pull.state;
  if (pull.checks === "FAILURE" || pull.checks === "ERROR") return "attention";
  if (pull.reviewDecision === "CHANGES_REQUESTED") return "attention";
  if (pull.mergeState === "DIRTY" || pull.mergeState === "BLOCKED")
    return "attention";
  if (pull.checks === "PENDING" || pull.checks === "EXPECTED") return "pending";
  if (pull.mergeState === "CLEAN" && pull.reviewDecision !== "REVIEW_REQUIRED")
    return "ready";
  return "open";
}

export function linkedPullDirectory(
  rows: ConversationDirectoryPage["items"],
): PullDirectoryRow[] {
  const pulls = new Map<string, PullDirectoryRow>();
  for (const row of rows)
    for (const pull of row.pulls) {
      const key = githubPullRequestKey(pull.url);
      const found = pulls.get(key);
      if (found) {
        if (
          !found.threads.some(
            (thread) => thread.kind === row.kind && thread.id === row.id,
          )
        )
          found.threads.push(row);
        continue;
      }
      const match =
        /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(
          pull.url,
        );
      if (!match) continue;
      pulls.set(key, {
        ...pull,
        repo: match[1],
        number: Number(match[2]),
        author: null,
        authorAvatar: null,
        updatedAt: row.at,
        createdAt: null,
        body: null,
        head: null,
        base: null,
        headSha: null,
        checks: null,
        mergeState: null,
        reviewDecision: null,
        labels: [],
        threads: [row],
      });
    }
  return [...pulls.values()];
}

/** A saved combination of view, filters and grouping, kept per device like the filters themselves. */
export type SavedPullView = {
  name: string;
  filters: PullFilters;
  repo: string;
  grouping: PullGroup;
};
export type PullFilters = {
  view: PullView;
  search: string;
  state: PullState | "";
  author: string;
  linked: boolean;
  label: string;
};
/** The states a reading view admits, so the tab and the state chip beside it are
 *  one condition rather than two that can disagree. All is no condition at all. */
export function pullViewStates(view: PullView): PullState[] {
  if (view === "all") return [];
  if (view !== "open") return [view];
  return ["attention", "pending", "ready", "open", "draft"];
}

export function filterDirectoryPulls(
  rows: PullDirectoryRow[],
  filter: PullFilters,
) {
  const search = filter.search.trim().toLocaleLowerCase();
  // One state condition at a time: a chosen state replaces the view's own, which
  // is what the chip row shows — the view's chip steps aside while it is on.
  const admitted = filter.state ? [] : pullViewStates(filter.view);
  return rows.filter((pull) => {
    const state = pullDirectoryState(pull);
    return (
      (!admitted.length || admitted.includes(state)) &&
      (!filter.state || state === filter.state) &&
      (!filter.author || pull.author === filter.author) &&
      (!filter.linked || pull.threads.length > 0) &&
      (!filter.label || pull.labels.includes(filter.label)) &&
      (!search ||
        [
          pull.title,
          pull.repo,
          `#${pull.number}`,
          pull.author,
          ...pull.threads.map((row) => row.title),
        ].some((value) => value?.toLocaleLowerCase().includes(search)))
    );
  });
}

/** Groups read in the order Capy shows them: what can ship now, then what is
 *  stuck, then what is simply in flight, then history. */
export const pullGroupOrder: readonly PullState[] = [
  "ready",
  "attention",
  "pending",
  "open",
  "draft",
  "merged",
  "closed",
];

export function groupDirectoryPulls(
  rows: PullDirectoryRow[],
  grouping: PullGroup,
  pinned: string[],
) {
  const pins = new Set(pinned);
  const groups = new Map<string, PullDirectoryRow[]>();
  const sorted = [...rows].sort(
    (a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number,
  );
  for (const row of sorted) {
    const key = pins.has(githubPullRequestKey(row.url))
      ? "pinned"
      : grouping === "state"
        ? pullDirectoryState(row)
        : grouping === "repo"
          ? row.repo
          : grouping === "author"
            ? (row.author ?? "unknownAuthor")
            : "results";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const order: string[] =
    grouping === "state"
      ? ["pinned", ...pullGroupOrder]
      : ["pinned", ...[...groups.keys()].filter((key) => key !== "pinned")];
  return order.flatMap((key) =>
    groups.has(key) ? [{ key, rows: groups.get(key)! }] : [],
  );
}

/** One pull request as its own page reads it (app/api/integrations/github/repositories/pulls/detail). */
export type PullCheck = {
  name: string;
  /** Collapsed to the page's words: passed, failed, pending, skipped. */
  state: "success" | "failure" | "pending" | "skipped";
  url: string | null;
};
export type PullReview = {
  author: string | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string | null;
};
export type PullDetail = Omit<PullDirectoryRow, "threads"> & {
  changedFiles: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checkRuns: PullCheck[];
  /** GitHub stopped listing at the read's cap. */
  moreChecks: boolean;
  reviews: PullReview[];
};

/** The query for one pull request's page and its merge: the same admitted repository as the directory. */
export const pullDetailQuery = pullFilesQuery;

/** Merging one PR by itself, bound to the head the person looked at (app/api/integrations/github/repositories/pulls/merge). */
export const pullMergeInput = z.strictObject({
  repo: pullPageInput.shape.repo,
  number: z.number().int().positive().max(9_999_999_999),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
  method: z.enum(["merge", "squash", "rebase"]).optional(),
  /** The person saw failing checks and merges anyway (the review page's 仍然合并). */
  confirmFailedChecks: z.boolean().default(false),
});
export type PullMergeInput = z.input<typeof pullMergeInput>;
export type PullMergeResult =
  | { kind: "merged"; mergeCommitSha: string | null }
  | { kind: "needs_confirm"; failing: number }
  | { kind: "refused"; code: string };
