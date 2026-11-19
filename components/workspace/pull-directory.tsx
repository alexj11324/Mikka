"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite, { unstable_serialize } from "swr/infinite";
import { useTranslations } from "next-intl";
import { Copy, Pin, X } from "lucide-react";
import { listConversations } from "@/app/actions/task-runs";
import { withBasePath } from "@/lib/base-path";
import { useViewState } from "@/lib/hooks/view-state";
import { useLiveKey } from "@/hooks/use-live-key";
import { githubPullRequestKey } from "@/lib/issue-metadata";
import type { ConversationDirectoryPage } from "@/lib/conversation-directory-input";
import {
  filterDirectoryPulls,
  groupDirectoryPulls,
  linkedPullDirectory,
  pullViews,
  type PullDirectoryPage,
  type PullDirectoryRow,
  type PullState,
  type PullFilters,
  type PullGroup,
  type SavedPullView,
} from "@/lib/pull-directory";
import { Button } from "@/components/ui/button";
import { PULL_REQUEST_ICONS } from "@/lib/pull-request-appearance";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResizablePane } from "@/components/ui/resizable-pane";
import { cn } from "cn";
import { PullConnectState, PullFilterBar } from "./pull-filters";
import { PullPreview } from "./pull-preview";
import { PullGroupHeader, PullRow, PullRowSkeleton } from "./pull-row";

const EmptyMark = PULL_REQUEST_ICONS.open;

const viewKeys: Record<PullFilters["view"], `views.${PullFilters["view"]}`> = {
  open: "views.open",
  ready: "views.ready",
  merged: "views.merged",
  all: "views.all",
};
const initial: PullFilters = {
  view: "open",
  search: "",
  state: "",
  author: "",
  linked: false,
  label: "",
};
type RepoStatus = {
  viewerId: string;
  connected: boolean;
  repositories: { fullName: string }[];
};
const stateKeys: Record<PullState, `states.${PullState}`> = {
  ready: "states.ready",
  pending: "states.pending",
  failed: "states.failed",
  draft: "states.draft",
  open: "states.open",
  merged: "states.merged",
  closed: "states.closed",
};
async function read<T>(path: string, ownerId: string): Promise<T> {
  const response = await fetch(withBasePath(path), { cache: "no-store" });
  const body = await response.json();
  if (!response.ok || (body.viewerId && body.viewerId !== ownerId))
    throw new Error("pullDirectoryReadFailed");
  return body as T;
}

/** PR-native page. Thread archive/read settings deliberately remain in the thread directory. */
export function PullDirectory({
  ownerId,
  workspaceId,
  botId,
  revision = 0,
}: {
  ownerId: string;
  workspaceId: string | null;
  botId: string | null;
  revision?: number;
}) {
  const t = useTranslations("PullDirectory");
  const scope = `pull-directory:${ownerId}:${workspaceId}:${botId ?? "all"}`;
  const [filters, setFilters] = useViewState<PullFilters>(
    scope + ":filters",
    initial,
  );
  const [repo, setRepo] = useViewState(scope + ":repo", "");
  const [grouping, setGrouping] = useViewState<PullGroup>(
    scope + ":group",
    "state",
  );
  const [pinned, setPinned] = useViewState<string[]>(scope + ":pinned", []);
  const [views, setViews] = useViewState<SavedPullView[]>(scope + ":views", []);
  const [checked, setChecked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"copied" | "copyError" | null>(
    null,
  );
  const [collapsed, setCollapsed] = useViewState<string[]>(
    scope + ":collapsed",
    [],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const {
    data: repositories,
    error: repositoryError,
    mutate: retryRepositories,
  } = useSWR<RepoStatus>(
    workspaceId ? [scope, "repositories"] : null,
    () => read("/api/integrations/github", ownerId),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const linkedKey = (
    index: number,
    previous: ConversationDirectoryPage | null,
  ) =>
    !workspaceId || (index > 0 && !previous?.cursor)
      ? null
      : ([
          "pull-linked",
          ownerId,
          workspaceId,
          botId,
          previous?.cursor ?? null,
          revision,
        ] as const);
  const linked = useSWRInfinite<
    ConversationDirectoryPage,
    Error,
    typeof linkedKey
  >(
    linkedKey,
    ([, , , bot, cursor]) =>
      listConversations({
        botId: bot ?? undefined,
        archived: "any",
        pullState: "linked",
        cursor: cursor ?? undefined,
      }),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const githubKey = (index: number, previous: PullDirectoryPage | null) =>
    !workspaceId || !repo || (index > 0 && !previous?.cursor)
      ? null
      : ([
          "pull-github",
          ownerId,
          workspaceId,
          repo,
          filters.view,
          previous?.cursor ?? null,
        ] as const);
  const github = useSWRInfinite<PullDirectoryPage, Error, typeof githubKey>(
    githubKey,
    ([, , , repository, view, cursor]) =>
      read(
        "/api/integrations/github/repositories/pulls?" +
          new URLSearchParams({
            repo: repository,
            view,
            ...(cursor ? { cursor } : {}),
          }),
        ownerId,
      ),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  useLiveKey(
    "thread_list",
    workspaceId,
    workspaceId
      ? [
          unstable_serialize(linkedKey),
          ...(repo ? [unstable_serialize(githubKey)] : []),
        ]
      : [],
    workspaceId,
  );
  // GitHub's webhook invalidations are task-scoped; the repository view also has an explicit refresh, never a timer.
  const linkedRows = linkedPullDirectory(
    linked.data?.flatMap((page) => page.items) ?? [],
  );
  const linkedByUrl = new Map(
    linkedRows.map((row) => [githubPullRequestKey(row.url), row.threads]),
  );
  const data = repo ? github.data : linked.data;
  const rows = repo
    ? [
        ...new Map(
          github.data
            ?.flatMap((page) => page.items)
            .map((row) => [
              githubPullRequestKey(row.url),
              {
                ...row,
                threads: linkedByUrl.get(githubPullRequestKey(row.url)) ?? [],
              },
            ]),
        ).values(),
      ]
    : linkedRows;
  const error = repo ? github.error : linked.error;
  const busy = repo ? github.isValidating : linked.isValidating;
  const more = Boolean(data?.at(-1)?.cursor);
  const visible = filterDirectoryPulls(rows, filters);
  const groups = groupDirectoryPulls(visible, grouping, pinned);
  const ordered = groups.flatMap((group) =>
    collapsed.includes(group.key) ? [] : group.rows,
  );
  const active = visible.find((row) => row.url === selected);
  const visibleChecked = visible.filter((row) => checked.includes(row.url));
  const set = (patch: Partial<PullFilters>) => {
    setFilters((previous) => ({ ...previous, ...patch }));
    setSelected(null);
    setChecked([]);
    setCopyState(null);
  };
  const changeRepo = (value: string) => {
    setRepo(value);
    setSelected(null);
    setChecked([]);
    setCopyState(null);
    setFilters((previous) => ({
      ...previous,
      author: "",
      label: "",
      linked: false,
    }));
  };
  async function copy(urls: string[]) {
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      setCopyState("copied");
    } catch {
      setCopyState("copyError");
    }
  }
  async function refresh() {
    await Promise.all([linked.mutate(), ...(repo ? [github.mutate()] : [])]);
  }
  function select(row: PullDirectoryRow) {
    setSelected(row.url);
    setCopyState(null);
  }
  function pin(urls: string[]) {
    const keys = urls.map(githubPullRequestKey);
    setPinned((previous) =>
      keys.every((key) => previous.includes(key))
        ? previous.filter((key) => !keys.includes(key))
        : [...new Set([...previous, ...keys])],
    );
  }
  const heading = (key: string) =>
    key === "pinned" || key === "results" || key === "unknownAuthor"
      ? t(key)
      : grouping === "state"
        ? t(stateKeys[key as PullState])
        : key;
  const filtered =
    filters.search ||
    filters.state ||
    filters.author ||
    filters.label ||
    filters.linked ||
    filters.view !== "all";
  const saveView = () => {
    const name = t("viewDefaultName", { view: t(`views.${filters.view}`) });
    setViews((previous) =>
      [
        ...previous.filter((view) => view.name !== name),
        { name, filters, repo, grouping },
      ].slice(-12),
    );
  };
  return (
    <section
      aria-label={t("title")}
      data-slot="pull-directory"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={(event) => {
        const editing = (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable=true],[role=combobox],[role=menu],[role=dialog]",
        );
        if (editing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "/") {
          event.preventDefault();
          searchRef.current?.focus();
        }
        if (event.key === "Escape") {
          setSelected(null);
          setChecked([]);
        }
        if (
          ["j", "k", "ArrowDown", "ArrowUp"].includes(event.key) &&
          ordered.length &&
          (event.target as HTMLElement).closest("[data-pull-list]")
        ) {
          event.preventDefault();
          const index = ordered.findIndex((row) => row.url === selected);
          const next =
            ordered[
              Math.max(
                0,
                Math.min(
                  ordered.length - 1,
                  index +
                    (event.key === "j" || event.key === "ArrowDown" ? 1 : -1),
                ),
              )
            ];
          select(next);
          event.currentTarget
            .querySelector<HTMLButtonElement>(
              `[data-pull-index="${ordered.indexOf(next)}"]`,
            )
            ?.focus();
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-4 pt-4">
        <h1 className="me-1 text-xl font-semibold">{t("title")}</h1>
        <Tabs
          value={filters.view}
          onValueChange={(value) => set({ view: value as PullFilters["view"], state: "" })}
        >
          <TabsList variant="line" aria-label={t("viewLabel")}>
            {pullViews.map((view) => (
              <TabsTrigger key={view} value={view}>
                {t(viewKeys[view])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <NativeSelect
          size="sm"
          aria-label={t("source")}
          value={repo}
          onChange={(event) => changeRepo(event.target.value)}
          className="ms-auto max-w-56"
        >
          <NativeSelectOption value="">{t("linkedPulls")}</NativeSelectOption>
          {repo && !(repositories?.repositories ?? []).some((row) => row.fullName === repo) && (
            <NativeSelectOption value={repo}>{repo}</NativeSelectOption>
          )}
          {(repositories?.repositories ?? []).map((row) => (
            <NativeSelectOption key={row.fullName} value={row.fullName}>
              {row.fullName}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <PullFilterBar
        filters={filters}
        grouping={grouping}
        repo={repo}
        authors={[...new Set(rows.flatMap((row) => (row.author ? [row.author] : [])))].sort()}
        labels={[...new Set(rows.flatMap((row) => row.labels))].sort()}
        total={rows.length}
        shown={visible.length}
        busy={busy}
        searchRef={searchRef}
        onChange={set}
        onGrouping={setGrouping}
        onRefresh={() => void refresh()}
        views={views}
        onApplyView={(view) => {
          setFilters(view.filters);
          setRepo(view.repo);
          setGrouping(view.grouping);
          setSelected(null);
          setChecked([]);
        }}
        onDeleteView={(name) => setViews((previous) => previous.filter((view) => view.name !== name))}
        onSaveView={saveView}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          data-pull-list
          tabIndex={0}
          aria-label={t("list")}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-auto pb-4 outline-none",
            active && "hidden md:block",
          )}
        >
          <div className="px-2">
            {repositoryError || (repositories && !repositories.connected) ? (
              <PullConnectState
                error={Boolean(repositoryError)}
                busy={busy}
                onRetry={() => void retryRepositories()}
              />
            ) : null}
            {error && (
              <div role="alert" className="mx-4 mt-6 flex flex-col items-start gap-3 rounded-xl bg-control px-4 py-4">
                <p className="text-sm text-foreground">{t("loadError")}</p>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
                  {t("retry")}
                </Button>
              </div>
            )}
            {!data && !error && (
              <div role="status" aria-label={t("loading")} className="flex flex-col py-1">
                {[0, 1, 2, 3, 4, 5, 6].map((key) => (
                  <PullRowSkeleton key={key} />
                ))}
              </div>
            )}
            {data && !visible.length && !error && (
              <Empty className="min-h-72 border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <EmptyMark />
                  </EmptyMedia>
                  <EmptyTitle>{t(filtered ? "noMatches" : "empty")}</EmptyTitle>
                  {more && <EmptyDescription>{t("noLoadedMatches")}</EmptyDescription>}
                </EmptyHeader>
                <EmptyContent>
                  {filtered ? (
                    <Button size="sm" variant="secondary" onClick={() => setFilters(initial)}>
                      {t("clearFilters")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                      {t("refresh")}
                    </Button>
                  )}
                </EmptyContent>
              </Empty>
            )}
            {groups.map((group) => {
              const open = !collapsed.includes(group.key);
              return (
                <section key={group.key} aria-label={heading(group.key)} className="flex flex-col">
                  <PullGroupHeader
                    label={heading(group.key)}
                    count={group.rows.length}
                    open={open}
                    onToggle={() =>
                      setCollapsed((previous) =>
                        open
                          ? [...previous, group.key]
                          : previous.filter((key) => key !== group.key),
                      )
                    }
                  />
                  {open && (
                    <ul className="flex flex-col">
                      {group.rows.map((row) => (
                        <PullRow
                          key={row.url}
                          row={row}
                          index={ordered.indexOf(row)}
                          selected={selected === row.url}
                          checked={checked.includes(row.url)}
                          pinned={pinned.includes(githubPullRequestKey(row.url))}
                          onSelect={select}
                          onCheck={(url, next) => {
                            setChecked((previous) =>
                              next
                                ? [...new Set([...previous, url])]
                                : previous.filter((item) => item !== url),
                            );
                            setCopyState(null);
                          }}
                          onPin={(url) => pin([url])}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
            {more && (
              <div className="flex justify-center py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void (repo ? github.setSize(github.size + 1) : linked.setSize(linked.size + 1))
                  }
                >
                  {t(busy ? "loading" : "more")}
                </Button>
              </div>
            )}
          </div>
        </div>
        {active && (
          <ResizablePane
            render="aside"
            role="region"
            aria-label={t("preview")}
            label={t("resizePreview")}
            storageKey={scope + ":width"}
            defaultWidth={420}
            min={320}
            max={720}
            edge="start"
            from="md"
            className="flex min-h-0 w-full flex-col border-s border-rule bg-background md:w-96"
          >
            <PullPreview row={active} source={Boolean(repo)} onClose={() => setSelected(null)} />
          </ResizablePane>
        )}
      </div>
      {visibleChecked.length > 0 && (
        <div
          aria-label={t("selection")}
          className="mx-2 mb-2 flex flex-wrap items-center gap-1 rounded-lg bg-control px-3 py-1.5"
        >
          <span className="me-auto text-xs tabular-nums text-muted-foreground">
            {t("selected", { count: visibleChecked.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copy(visibleChecked.map((row) => row.url))}
          >
            <Copy data-icon />
            {t("copyLinks")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => pin(visibleChecked.map((row) => row.url))}>
            <Pin data-icon />
            {t(
              visibleChecked.every((row) => pinned.includes(githubPullRequestKey(row.url)))
                ? "unpin"
                : "pin",
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setChecked([])}>
            <X data-icon />
            {t("deselect")}
          </Button>
          {copyState && (
            <span
              role={copyState === "copyError" ? "alert" : "status"}
              className={cn(
                "ms-1 text-xs",
                copyState === "copyError" ? "text-destructive-foreground" : "text-muted-foreground",
              )}
            >
              {t(copyState)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
