import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterDirectoryPulls,
  groupDirectoryPulls,
  linkedPullDirectory,
  pullDirectoryState,
  pullFilesQuery,
  pullFromAddress,
  pullPageHref,
  pullPageInput,
  pullSinceInstant,
  readSavedPullView,
  pullReviewRef,
  pullStates,
  pullViewStates,
  pullViews,
  type PullDirectoryRow,
  type PullState,
} from "./pull-directory";
const row = (changes: Partial<PullDirectoryRow> = {}): PullDirectoryRow => ({
  url: "https://github.com/Owner/Repo/pull/1",
  repo: "Owner/Repo",
  number: 1,
  state: "open",
  title: "Fix sidebar",
  author: "alex",
  authorAvatar: null,
  updatedAt: "2026-11-18T04:00:00Z",
  createdAt: null,
  body: null,
  head: null,
  base: null,
  headSha: null,
  checks: null,
  mergeState: null,
  reviewDecision: null,
  labels: [],
  threads: [],
  ...changes,
});
const filter = {
  view: "all" as const,
  search: "",
  state: "" as const,
  author: "",
  label: "",
  linked: false,
  since: "" as const,
  project: "",
};
test("passing checks are not enough to claim merge readiness", () => {
  assert.equal(pullDirectoryState(row({ checks: "SUCCESS" })), "open");
  assert.equal(
    pullDirectoryState(
      row({
        checks: "SUCCESS",
        mergeState: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
      }),
    ),
    "open",
  );
  assert.equal(
    pullDirectoryState(
      row({
        checks: "SUCCESS",
        mergeState: "CLEAN",
        reviewDecision: "APPROVED",
      }),
    ),
    "ready",
  );
  for (const state of ["draft", "merged", "closed"] as const)
    assert.equal(
      pullDirectoryState(
        row({ state, checks: "FAILURE", mergeState: "CLEAN" }),
      ),
      state,
    );
  assert.equal(pullDirectoryState(row({ checks: "PENDING" })), "pending");
});
test("needs attention covers every way a pull request is stuck, not only a red check", () => {
  assert.equal(pullDirectoryState(row({ checks: "FAILURE" })), "attention");
  assert.equal(pullDirectoryState(row({ checks: "ERROR" })), "attention");
  assert.equal(
    pullDirectoryState(row({ checks: "SUCCESS", mergeState: "DIRTY" })),
    "attention",
  );
  assert.equal(
    pullDirectoryState(row({ checks: "SUCCESS", mergeState: "BLOCKED" })),
    "attention",
  );
  assert.equal(
    pullDirectoryState(
      row({
        checks: "SUCCESS",
        mergeState: "CLEAN",
        reviewDecision: "CHANGES_REQUESTED",
      }),
    ),
    "attention",
  );
});
test("groups read ready first, then what is stuck, matching the view that leads the page", () => {
  const rowIn = (state: PullState, number: number) =>
    row({
      number,
      checks: state === "attention" ? "FAILURE" : null,
      mergeState: state === "ready" ? "CLEAN" : null,
      updatedAt: `2026-11-1${number}T04:00:00Z`,
    });
  const groups = groupDirectoryPulls(
    [rowIn("ready", 3), rowIn("attention", 2), rowIn("ready", 1)],
    "state",
    [],
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    ["ready", "attention"],
  );
  assert.deepEqual(
    groups[0].rows.map((group) => group.number),
    [3, 1],
  );
});
test("the reading view and its state chip are one condition", () => {
  assert.deepEqual(pullViewStates("open"), [
    "attention",
    "pending",
    "ready",
    "open",
    "draft",
  ]);
  assert.deepEqual(pullViewStates("ready"), ["ready"]);
  assert.deepEqual(pullViewStates("all"), []);
  // One row that reads as each state, so the table can prove the tab and the
  // state filter admit exactly the same rows instead of drifting apart.
  const readsAs = (state: PullState) =>
    row(
      state === "attention"
        ? { checks: "FAILURE" }
        : state === "pending"
          ? { checks: "PENDING" }
          : state === "ready"
            ? { mergeState: "CLEAN" }
            : state === "draft" || state === "merged" || state === "closed"
              ? { state }
              : {},
    );
  for (const state of pullStates) {
    const pull = readsAs(state);
    assert.equal(pullDirectoryState(pull), state);
    for (const view of pullViews)
      assert.equal(
        filterDirectoryPulls([pull], { ...filter, view, state: "" }).length,
        view === "all" || pullViewStates(view).includes(state) ? 1 : 0,
        `${view}/${state}`,
      );
    // A chosen state replaces the view's condition rather than intersecting it:
    // "Merged" on the 打开 tab is still the merged pull request, not nothing.
    for (const view of pullViews)
      assert.equal(
        filterDirectoryPulls([pull], { ...filter, view, state }).length,
        1,
        `${view}/${state} with the state filter on`,
      );
  }
});
test("PR title, repository, number and author search instead of thread-only search", () => {
  for (const search of ["sidebar", "owner/repo", "#1", "ALEX"])
    assert.equal(
      filterDirectoryPulls([row()], { ...filter, search }).length,
      1,
    );
  assert.equal(
    filterDirectoryPulls([row()], { ...filter, search: "missing" }).length,
    0,
  );
  assert.equal(
    filterDirectoryPulls([row()], { ...filter, author: "other" }).length,
    0,
  );
  assert.equal(
    filterDirectoryPulls([row({ labels: ["bug"] })], {
      ...filter,
      label: "bug",
    }).length,
    1,
  );
  assert.equal(
    filterDirectoryPulls([row()], { ...filter, view: "ready" }).length,
    0,
  );
  assert.equal(
    filterDirectoryPulls([row({ state: "merged" })], {
      ...filter,
      view: "open",
    }).length,
    0,
  );
  assert.equal(
    filterDirectoryPulls([row({ state: "draft" })], { ...filter, view: "open" })
      .length,
    1,
  );
});
test("case-insensitive canonical identity deduplicates linked PRs and keeps authorized thread links", () => {
  const first = {
    id: "first",
    kind: "run" as const,
    pulls: [{ url: row().url, state: "draft" as const, title: "Fix sidebar" }],
    at: row().updatedAt,
    title: "Thread",
    state: "idle" as const,
    issueId: null,
    identifier: null,
    taskTitle: null,
    pinned: false,
  };
  const second = {
    ...first,
    id: "second",
    pulls: [{ ...first.pulls[0], url: row().url.toLowerCase() + "/" }],
  };
  const result = linkedPullDirectory([first, second, second]);
  assert.equal(result.length, 1);
  assert.equal(result[0].threads.length, 2);
  assert.equal(result[0].checks, null);
  assert.equal(pullDirectoryState(result[0]), "draft");
  assert.deepEqual([result[0].author, result[0].head, result[0].createdAt, result[0].headSha], [null, null, null, null]);
  const recorded = linkedPullDirectory([{ ...first, pulls: [{ ...first.pulls[0], author: "dana", head: "fix/sidebar",
    headSha: "A".repeat(40), createdAt: "2026-11-17T00:00:00Z" }] }]);
  assert.deepEqual([recorded[0].author, recorded[0].head, recorded[0].createdAt, recorded[0].headSha],
    ["dana", "fix/sidebar", "2026-11-17T00:00:00Z", "a".repeat(40)], "a linked PR carries what Copy branch and the author filter need");
});
test("pinned and grouped PRs retain stable updated order without duplication", () => {
  const rows = [
    row(),
    row({
      url: "https://github.com/Other/Repo/pull/2",
      repo: "Other/Repo",
      number: 2,
      state: "draft",
    }),
  ];
  const groups = groupDirectoryPulls(rows, "repo", [rows[1].url.toLowerCase()]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["pinned", "Owner/Repo"],
  );
  assert.equal(groups.flatMap((group) => group.rows).length, 2);
  assert.equal(groupDirectoryPulls(rows, "none", [])[0].rows[0].number, 2);
});
test("input bounds reject URLs, arbitrary states, huge cursors and path traversal", () => {
  for (const input of [
    { repo: "https://github.com/Owner/Repo" },
    { repo: "Owner/../Repo" },
    { repo: "Owner/Repo", view: "green" },
    { repo: "Owner/Repo", cursor: "x".repeat(1025) },
  ])
    assert.equal(pullPageInput.safeParse(input).success, false);
  assert.deepEqual(pullPageInput.parse({ repo: "Owner/Repo" }), {
    repo: "Owner/Repo",
    cursor: null,
    view: "open",
    since: null,
  });
});

test("a row's pull request opens by its reference, never by its URL", () => {
  assert.deepEqual(pullReviewRef({ repo: "Owner/Repo", number: 7 }), {
    owner: "Owner",
    repo: "Repo",
    number: 7,
  });
  // A row that does not name a repository offers no review it could not read.
  assert.equal(pullReviewRef({ repo: "Repo", number: 7 }), null);
  assert.equal(pullReviewRef({ repo: "Owner/Repo/Sub", number: 7 }), null);
  for (const query of [
    { repo: "Owner/Repo", number: "0" },
    { repo: "Owner/Repo", number: "-7" },
    { repo: "Owner/Repo", number: "7.5" },
    { repo: "Owner/Repo", number: "https://github.com/Owner/Repo/pull/7" },
    { repo: "Owner/Repo", number: 7 },
    { repo: "Owner/Repo", number: "7", cursor: "next" },
  ])
    assert.equal(
      pullFilesQuery.safeParse(query).success,
      false,
      String(query.number),
    );
  assert.deepEqual(pullFilesQuery.parse({ repo: "Owner/Repo", number: "7" }), {
    repo: "Owner/Repo",
    number: "7",
  });
});

test("Created keeps PRs opened inside the range and drops ones whose opening is unknown", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  assert.equal(pullSinceInstant("week", now), "2026-11-13T00:00:00.000Z");
  assert.equal(pullSinceInstant("", now), null);
  const rows = [
    row({ number: 1, createdAt: "2026-11-19T00:00:00Z" }),
    row({ number: 2, createdAt: "2026-11-01T00:00:00+00:00" }),
    row({ number: 3, createdAt: null }),
  ];
  assert.deepEqual(filterDirectoryPulls(rows, { ...filter, since: "week" }, now).map((item) => item.number), [1]);
  assert.equal(filterDirectoryPulls(rows, filter, now).length, 3);
});
test("a PR's own address round-trips and refuses anything that is not one repository's PR", () => {
  const href = pullPageHref({ repo: "Owner/Repo.js", number: 12 }, "00000000-0000-4000-8000-000000000001");
  assert.ok(href);
  const query = new URL(href, "https://mikka.invalid").searchParams;
  assert.equal(query.get("section"), "pulls");
  assert.equal(query.get("workspace"), "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(pullFromAddress(query.get("pull")), { repo: "Owner/Repo.js", number: 12 });
  for (const bad of [null, "", "Owner/Repo", "Owner/Repo/0", "Owner/../7", "../Repo/7", "a/b/c/7", "Owner/Repo/7?x=1"])
    assert.equal(pullFromAddress(bad), null, String(bad));
  assert.equal(pullPageHref({ repo: "not-a-repo", number: 1 }, null), null);
});
test("a saved pulls view reads back with defaults for fields it predates and never applies another list's shape", () => {
  const view = readSavedPullView({ id: "v", name: "Mine", filters: { filters: { view: "merged", author: "dana" }, repo: "Owner/Repo", grouping: "author" } });
  assert.deepEqual(view, {
    id: "v",
    name: "Mine",
    filters: { view: "merged", search: "", state: "", author: "dana", linked: false, label: "", since: "", project: "" },
    repo: "Owner/Repo",
    grouping: "author",
  });
  assert.equal(readSavedPullView({ id: "v", name: "x", filters: { automation: "a" } }), null);
  assert.equal(readSavedPullView({ id: "v", name: "x", filters: { filters: {}, repo: "../x", grouping: "nope" } })?.repo, "");
});
