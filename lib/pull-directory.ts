import { z } from "zod";
import type { IssuePullRequest } from "./issue-metadata";
import { githubPullRequestKey } from "./issue-metadata";
import type { ConversationDirectoryPage } from "./conversation-directory-input";

export const pullViews = ["open", "ready", "merged", "all"] as const;
export const pullGroups = ["state", "repo", "author", "none"] as const;
export const pullStates = [
  "ready",
  "pending",
  "failed",
  "draft",
  "open",
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
});

export function pullDirectoryState(pull: PullDirectoryRow): PullState {
  if (
    pull.state === "merged" ||
    pull.state === "closed" ||
    pull.state === "draft"
  )
    return pull.state;
  if (pull.checks === "FAILURE" || pull.checks === "ERROR") return "failed";
  if (pull.checks === "PENDING" || pull.checks === "EXPECTED") return "pending";
  // A green check alone is not GitHub's mergeability or review decision.
  if (
    pull.mergeState === "CLEAN" &&
    pull.reviewDecision !== "CHANGES_REQUESTED" &&
    pull.reviewDecision !== "REVIEW_REQUIRED"
  )
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
export function filterDirectoryPulls(
  rows: PullDirectoryRow[],
  filter: PullFilters,
) {
  const search = filter.search.trim().toLocaleLowerCase();
  return rows.filter((pull) => {
    const state = pullDirectoryState(pull);
    return (
      (filter.view !== "open" || !["merged", "closed"].includes(state)) &&
      (filter.view !== "merged" || state === "merged") &&
      (filter.view !== "ready" || state === "ready") &&
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

/** Groups read in the order someone works them: what is broken, what is running, what is ready, then history. */
export const pullAttentionOrder: readonly PullState[] = [
  "failed",
  "pending",
  "ready",
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
      ? ["pinned", ...pullAttentionOrder]
      : ["pinned", ...[...groups.keys()].filter((key) => key !== "pinned")];
  return order.flatMap((key) =>
    groups.has(key) ? [{ key, rows: groups.get(key)! }] : [],
  );
}
