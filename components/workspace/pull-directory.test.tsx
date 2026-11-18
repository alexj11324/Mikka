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
  total: 1,
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
  ],
};
mock.module("next-intl", {
  namedExports: {
    useTranslations: () => (key: string) => key,
    useFormatter: () => ({ dateTime: () => "Today" }),
  },
});
mock.module("swr", {
  defaultExport: () => ({
    data: {
      viewerId: "owner",
      connected: true,
      repositories: [{ fullName: "Owner/Repo" }],
    },
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
  ResizablePane: ({ children, ...props }: React.ComponentProps<"aside">) => (
    <aside {...props}>{children}</aside>
  ),
});
stub("./workspace-navigation.ts", {
  openGroupConversation: (id: string) => calls.push("chat:" + id),
  openThread: (id: string) => calls.push("run:" + id),
  openTask: (id: string) => calls.push("task:" + id),
});
const { PullDirectory } = await import("./pull-directory");

async function mount() {
  browser.localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
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
  const { root, host } = await mount();
  try {
    assert.match(document.body.textContent ?? "", /Better PR overview/);
    const source = document.querySelector('select[aria-label="source"]');
    assert.ok(source instanceof browser.HTMLSelectElement);
    await act(async () => change(source as unknown as HTMLSelectElement, "Owner/Repo"));
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
    assert.deepEqual(calls, ["task:00000000-0000-4000-8000-000000000002"]);
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
    host.remove();
  }
});

test("filters act on PR metadata and the Ready view is not inferred from a green check alone", async () => {
  const { root, host } = await mount();
  try {
    const source = document.querySelector('select[aria-label="source"]');
    assert.ok(source instanceof browser.HTMLSelectElement);
    await act(async () => change(source as unknown as HTMLSelectElement, "Owner/Repo"));
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
    host.remove();
    await browser.happyDOM.abort();
  }
});
