import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { act } from "react";
import { Window } from "happy-dom";
import type { ConversationDirectoryPage } from "@/lib/conversation-directory-input";
import type { PullDirectoryPage } from "@/lib/pull-directory";

const browser = new Window();
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const calls: string[] = [];
const url = "https://github.com/Owner/Repo/pull/7";
const linkedPage: ConversationDirectoryPage = {
  cursor: null,
  items: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "run",
      issueId: "00000000-0000-4000-8000-000000000002",
      identifier: "MIK-7",
      title: "Implement PR directory",
      taskTitle: null,
      state: "idle",
      at: "2026-11-18T00:00:00.000000Z",
      pinned: false,
      pulls: [{ url, state: "open", title: "Better PR overview" }],
    },
  ],
};
const githubPage: PullDirectoryPage = {
  cursor: null,
  total: 2,
  items: [
    {
      url,
      repo: "Owner/Repo",
      number: 7,
      title: "Better PR overview",
      state: "open",
      author: "alex",
      authorAvatar: null,
      updatedAt: "2026-11-18T00:00:00Z",
      createdAt: "2026-11-17T00:00:00Z",
      body: "The description for review.",
      head: "feature/pr-page",
      base: "main",
      headSha: "a".repeat(40),
      checks: "SUCCESS",
      mergeState: "CLEAN",
      reviewDecision: "APPROVED",
      additions: 12,
      deletions: 3,
      labels: ["ui"],
      threads: [],
    },
    {
      url: "https://github.com/Owner/Repo/pull/8",
      repo: "Owner/Repo",
      number: 8,
      title: "Broken checks on the sidebar",
      state: "open",
      author: "alex",
      authorAvatar: null,
      updatedAt: "2026-11-17T00:00:00Z",
      createdAt: "2026-11-16T00:00:00Z",
      body: null,
      head: "fix/sidebar",
      base: "main",
      headSha: "b".repeat(40),
      checks: "FAILURE",
      mergeState: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      additions: 4,
      deletions: 40,
      labels: [],
      threads: [],
    },
  ],
};
mock.module("@/lib/intl/i18n-client", {
  namedExports: {
    useTranslations: () => (key: string) => key,
    useFormatter: () => ({ dateTime: () => "Today" }),
  },
});
/** What the GitHub connection read answers, per test: the page's one state that
 *  replaces the list rather than sitting above it is read from here. */
let repositoryStatus = {
  viewerId: "owner",
  connected: true,
  repositories: [{ fullName: "Owner/Repo" }],
};
mock.module("swr", {
  defaultExport: () => ({
    data: repositoryStatus,
    isValidating: false,
    mutate: async () => {},
  }),
});
mock.module("swr/infinite", {
  defaultExport: (
    getKey: (index: number, previous: null) => readonly unknown[] | null,
  ) => {
    const key = getKey(0, null);
    return {
      data:
        key?.[0] === "pull-github"
          ? [githubPage]
          : key
            ? [linkedPage]
            : undefined,
      isValidating: false,
      error: undefined,
      size: 1,
      setSize: async () => {},
      mutate: async () => {},
    };
  },
  namedExports: { unstable_serialize: () => "pull-directory" },
});
const stub = (file: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL(file, import.meta.url).href, { namedExports });
stub("../../hooks/use-live-key.tsx", { useLiveKey: () => {} });
stub("../../app/actions/task-runs.ts", { listConversations: () => linkedPage });
stub("../ui/resizable-pane.tsx", {
  ResizablePane: ({
    children,
    storageKey: _storageKey,
    defaultWidth: _defaultWidth,
    min: _min,
    max: _max,
    edge: _edge,
    label: _label,
    from: _from,
    render: _render,
    ...props
  }: React.ComponentProps<"aside"> & {
    storageKey?: string;
    defaultWidth?: number | null;
    min?: number;
    max?: number;
    edge?: "start" | "end";
    label?: string;
    from?: string;
    render?: "aside" | "div" | "section";
  }) => <aside {...props}>{children}</aside>,
});
stub("./workspace-navigation.ts", {
  openGroupConversation: (id: string) => calls.push("chat:" + id),
  openThread: (id: string) => calls.push("run:" + id),
  openTask: (id: string) => calls.push("task:" + id),
});
stub("../../hooks/code-review/use-review-page.ts", {
  openPullReview: (pull: { owner: string; repo: string; number: number }) =>
    calls.push(`pull:${pull.owner}/${pull.repo}#${pull.number}`),
});
const { PullDirectory } = await import("./pull-directory");

async function mount() {
  browser.localStorage.clear();
  const host = document.body;
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PullDirectory ownerId="owner" workspaceId="workspace" botId={null} />,
    ),
  );
  return { root, host };
}
function change(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    browser.HTMLSelectElement.prototype,
    "value",
  )?.set;
  assert.ok(setter);
  flushSync(() => {
    setter.call(select, value);
    select.dispatchEvent(
      new browser.Event("change", { bubbles: true }) as unknown as Event,
    );
  });
}

test("the PR tab switches from linked task snapshots to real repository PRs and opens a useful preview", async () => {
  calls.length = 0;
  const { root } = await mount();
  try {
    assert.match(document.body.textContent ?? "", /Better PR overview/);
    const source = document.querySelector('select[aria-label="source"]');
    assert.ok(source instanceof browser.HTMLSelectElement);
    await act(async () =>
      change(source as unknown as HTMLSelectElement, "Owner/Repo"),
    );
    const row = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Better PR overview"),
    );
    assert.ok(row);
    await act(async () => (row as HTMLButtonElement).click());
    const preview = document.querySelector('aside[role="region"]');
    assert.ok(preview);
    assert.match(preview.textContent ?? "", /feature\/pr-page/);
    assert.match(preview.textContent ?? "", /The description for review/);
    assert.match(preview.textContent ?? "", /checksState.SUCCESS/);
    const linkedTask = [...preview.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("MIK-7"),
    );
    assert.ok(linkedTask);
    await act(async () => (linkedTask as HTMLButtonElement).click());
    // The row's own press opened the PR's review first; the linked task still opens its task.
    assert.deepEqual(calls, [
      "pull:Owner/Repo#7",
      "task:00000000-0000-4000-8000-000000000002",
    ]);
    const pin = document.querySelector('button[aria-label="pin"]');
    assert.ok(pin);
    await act(async () => (pin as HTMLButtonElement).click());
    assert.equal(
      (
        document.querySelector(
          'button[aria-pressed="true"][aria-label="unpin"]',
        ) as HTMLButtonElement | null
      )?.getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("a row press opens the pull request in the app's review page, and GitHub stays a secondary action", async () => {
  calls.length = 0;
  const { root } = await mount();
  try {
    const source = document.querySelector('select[aria-label="source"]');
    assert.ok(source instanceof browser.HTMLSelectElement);
    await act(async () =>
      change(source as unknown as HTMLSelectElement, "Owner/Repo"),
    );
    const row = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Better PR overview"),
    );
    assert.ok(row);
    await act(async () => (row as HTMLButtonElement).click());
    // The PR's own reference, not its URL: the page reads it through the repository it belongs to.
    assert.deepEqual(calls, ["pull:Owner/Repo#7"]);
    const github = document.querySelector('a[aria-label="openGitHub"]');
    assert.ok(github instanceof browser.HTMLAnchorElement);
    assert.equal(github.getAttribute("href"), url);
    assert.equal(github.getAttribute("target"), "_blank");
    assert.equal(github.getAttribute("rel"), "noopener noreferrer");
  } finally {
    await act(async () => root.unmount());
  }
});

test("rows land in Capy's two buckets, and the reading view is a chip you can drop", async () => {
  const { root } = await mount();
  try {
    const source = document.querySelector('select[aria-label="source"]');
    assert.ok(source instanceof browser.HTMLSelectElement);
    await act(async () =>
      change(source as unknown as HTMLSelectElement, "Owner/Repo"),
    );
    const headings = [...document.querySelectorAll("section[aria-label]")]
      .map((section) => section.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("states."));
    // Ready first, then what is stuck, in the order the list shows them.
    assert.deepEqual(headings, ["states.ready", "states.attention"]);
    // The stuck row is the failing check, not the clean one next to it.
    const attention = document.querySelector(
      'section[aria-label="states.attention"]',
    );
    assert.match(attention?.textContent ?? "", /Broken checks on the sidebar/);
    assert.doesNotMatch(attention?.textContent ?? "", /Better PR overview/);
    // The reading view shows up as a condition, so the tab is not a hidden filter.
    const conditions = document.querySelector("[data-pull-conditions]");
    assert.ok(conditions);
    assert.match(conditions.textContent ?? "", /state/);
    assert.match(conditions.textContent ?? "", /eitherOfStates/);
    const remove = conditions.querySelector(
      'button[aria-label="removeFilter"]',
    );
    assert.ok(remove);
    await act(async () => (remove as HTMLButtonElement).click());
    // Dropping the condition widens the reading view to everything.
    assert.equal(document.querySelector("[data-pull-conditions]"), null);
    assert.match(document.body.textContent ?? "", /Broken checks on the sidebar/);
    assert.match(document.body.textContent ?? "", /Better PR overview/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("an unconnected GitHub is one state, not a notice above an empty list", async () => {
  repositoryStatus = { viewerId: "owner", connected: false, repositories: [] };
  const { root } = await mount();
  try {
    assert.match(document.body.textContent ?? "", /connectGitHub/);
    // The list's own "nothing matched" block would be a second answer beside it.
    assert.equal(document.querySelector('[data-slot="empty"]'), null);
    assert.equal(document.querySelectorAll('[role="status"]').length, 1);
  } finally {
    repositoryStatus = {
      viewerId: "owner",
      connected: true,
      repositories: [{ fullName: "Owner/Repo" }],
    };
    await act(async () => root.unmount());
  }
});

test("filters act on PR metadata and the Ready view is not inferred from a green check alone", async () => {
  const { root } = await mount();
  try {
    const source = document.querySelector('select[aria-label="source"]');
    assert.ok(source instanceof browser.HTMLSelectElement);
    await act(async () =>
      change(source as unknown as HTMLSelectElement, "Owner/Repo"),
    );
    const ready = [...document.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "views.ready",
    );
    assert.ok(ready);
    await act(async () => (ready as HTMLButtonElement).click());
    assert.match(document.body.textContent ?? "", /Better PR overview/);
    const search = document.querySelector('input[aria-label="search"]');
    assert.ok(search instanceof browser.HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(
      browser.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setter);
    await act(async () => {
      flushSync(() => {
        setter.call(search, "missing");
        search.dispatchEvent(
          new browser.Event("input", { bubbles: true }) as unknown as Event,
        );
      });
    });
    assert.match(document.body.textContent ?? "", /noMatches/);
  } finally {
    await act(async () => root.unmount());
    await browser.happyDOM.abort();
  }
});
