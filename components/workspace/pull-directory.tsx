"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite, { unstable_serialize } from "swr/infinite";
import { useFormatter, useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Pin,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
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
  pullDirectoryState,
  pullGroups,
  pullStates,
  pullViews,
  type PullDirectoryPage,
  type PullDirectoryRow,
  type PullState,
  type PullFilters,
  type PullGroup,
} from "@/lib/pull-directory";
import {
  PULL_REQUEST_COLORS,
  PULL_REQUEST_ICONS,
} from "@/lib/pull-request-appearance";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ResizablePane } from "@/components/ui/resizable-pane";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  openGroupConversation,
  openTask,
  openThread,
} from "./workspace-navigation";

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
type SavedView = {
  name: string;
  filters: PullFilters;
  repo: string;
  grouping: PullGroup;
};
const viewKeys: Record<PullFilters["view"], `views.${PullFilters["view"]}`> = {
  open: "views.open",
  ready: "views.ready",
  merged: "views.merged",
  all: "views.all",
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
const groupKeys: Record<PullGroup, `groups.${PullGroup}`> = {
  state: "groups.state",
  repo: "groups.repo",
  author: "groups.author",
  none: "groups.none",
};
type CheckState = NonNullable<PullDirectoryRow["checks"]> | "unknown";
const checkKeys: Record<CheckState, `checksState.${CheckState}`> = {
  SUCCESS: "checksState.SUCCESS",
  PENDING: "checksState.PENDING",
  FAILURE: "checksState.FAILURE",
  ERROR: "checksState.ERROR",
  EXPECTED: "checksState.EXPECTED",
  unknown: "checksState.unknown",
};
type ReviewState =
  "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "unknown";
const reviewKeys: Record<ReviewState, `reviewState.${ReviewState}`> = {
  APPROVED: "reviewState.APPROVED",
  CHANGES_REQUESTED: "reviewState.CHANGES_REQUESTED",
  REVIEW_REQUIRED: "reviewState.REVIEW_REQUIRED",
  unknown: "reviewState.unknown",
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
  const [views, setViews] = useViewState<SavedView[]>(scope + ":views", []);
  const [viewName, setViewName] = useState("");
  const [savingView, setSavingView] = useState(false);
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
  const stateLabel = (row: PullDirectoryRow) =>
    t(stateKeys[pullDirectoryState(row)]);
  const heading = (key: string) =>
    key === "pinned" || key === "results" || key === "unknownAuthor"
      ? t(key)
      : grouping === "state"
        ? t(stateKeys[key as PullState])
        : key;
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
      <header className="flex flex-col gap-3 px-4 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-base font-semibold">{t("title")}</h1>
          <NativeSelect
            aria-label={t("source")}
            value={repo}
            onChange={(event) => changeRepo(event.target.value)}
            className="max-w-64"
          >
            <NativeSelectOption value="">{t("linkedPulls")}</NativeSelectOption>
            {repo &&
              !repositories?.repositories.some(
                (row) => row.fullName === repo,
              ) && <NativeSelectOption value={repo}>{repo}</NativeSelectOption>}
            {repositories?.repositories.map((row) => (
              <NativeSelectOption key={row.fullName} value={row.fullName}>
                {row.fullName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("refresh")}
            title={t("refresh")}
            disabled={busy || !workspaceId}
            onClick={() => void refresh()}
          >
            <RefreshCw data-icon className={cn(busy && "animate-spin")} />
          </Button>
          {repo && (
            <Button
              size="sm"
              variant="outline"
              render={
                <a
                  href={`https://github.com/${repo}/compare`}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <Plus data-icon />
              {t("newPull")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={filters.view}
            onValueChange={(value) =>
              set({ view: value as PullFilters["view"], state: "" })
            }
          >
            <TabsList variant="line" aria-label={t("viewLabel")}>
              {pullViews.map((view) => (
                <TabsTrigger key={view} value={view}>
                  {t(viewKeys[view])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <FieldGroup className="min-w-48 flex-1">
            <Field className="gap-0">
              <SearchInput
                ref={searchRef}
                value={filters.search}
                maxLength={120}
                aria-label={t("search")}
                placeholder={t("search")}
                onChange={(event) => set({ search: event.target.value })}
              />
            </Field>
          </FieldGroup>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label={t("state")}
            value={filters.state}
            onChange={(event) =>
              set({ state: event.target.value as PullFilters["state"] })
            }
          >
            <NativeSelectOption value="">{t("state")}</NativeSelectOption>
            {pullStates.map((state) => (
              <NativeSelectOption key={state} value={state}>
                {t(stateKeys[state])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {repo && (
            <>
              <NativeSelect
                aria-label={t("author")}
                value={filters.author}
                onChange={(event) => set({ author: event.target.value })}
              >
                <NativeSelectOption value="">{t("author")}</NativeSelectOption>
                {[
                  ...new Set(
                    rows.flatMap((row) => (row.author ? [row.author] : [])),
                  ),
                ]
                  .sort()
                  .map((author) => (
                    <NativeSelectOption key={author} value={author}>
                      {author}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <NativeSelect
                aria-label={t("label")}
                value={filters.label}
                onChange={(event) => set({ label: event.target.value })}
              >
                <NativeSelectOption value="">{t("label")}</NativeSelectOption>
                {[...new Set(rows.flatMap((row) => row.labels))]
                  .sort()
                  .map((label) => (
                    <NativeSelectOption key={label} value={label}>
                      {label}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </>
          )}
          <NativeSelect
            aria-label={t("grouping")}
            value={grouping}
            onChange={(event) => setGrouping(event.target.value as PullGroup)}
          >
            {pullGroups.map((group) => (
              <NativeSelectOption key={group} value={group}>
                {t(groupKeys[group])}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters(initial);
              setSelected(null);
              setChecked([]);
            }}
          >
            {t("clearFilters")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSavingView((value) => !value)}
          >
            {t("saveView")}
          </Button>
          {views.map((view, index) => (
            <span key={index} className="inline-flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFilters(view.filters);
                  setRepo(view.repo);
                  setGrouping(view.grouping);
                  setSelected(null);
                  setChecked([]);
                }}
              >
                {view.name}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("deleteView", { name: view.name })}
                onClick={() =>
                  setViews((previous) => previous.filter((_, i) => i !== index))
                }
              >
                <X data-icon />
              </Button>
            </span>
          ))}
        </div>
        {savingView && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!viewName.trim()) return;
              setViews((previous) =>
                [
                  ...previous.filter((view) => view.name !== viewName.trim()),
                  { name: viewName.trim(), filters, repo, grouping },
                ].slice(-12),
              );
              setSavingView(false);
              setViewName("");
            }}
          >
            <Input
              autoFocus
              maxLength={40}
              aria-label={t("viewName")}
              placeholder={t("viewName")}
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={!viewName.trim()}>
              {t("save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setSavingView(false)}
            >
              {t("cancel")}
            </Button>
          </form>
        )}
        {(repositoryError || (repositories && !repositories.connected)) && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {t(repositoryError ? "repositoryError" : "connectGitHub")}
            {repositoryError && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void retryRepositories()}
              >
                {t("retry")}
              </Button>
            )}
            <Button
              size="sm"
              variant="link"
              render={<a href={withBasePath("/?settings=integrations")} />}
            >
              {t("connections")}
            </Button>
          </p>
        )}
      </header>
      {error && (
        <div role="alert" className="flex items-center gap-2 px-4 py-2">
          {t("loadError")}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          data-pull-list
          tabIndex={0}
          aria-label={t("list")}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-auto px-2 pb-4 outline-none",
            active && "hidden md:block",
          )}
        >
          {!data && !error && (
            <div
              role="status"
              aria-label={t("loading")}
              className="flex flex-col gap-3 p-3"
            >
              {[0, 1, 2, 3, 4].map((key) => (
                <Skeleton key={key} className="h-9 w-full" />
              ))}
            </div>
          )}
          {data && !visible.length && !error && (
            <p
              role="status"
              className="px-3 py-16 text-center text-sm text-muted-foreground"
            >
              {t(
                more
                  ? "noLoadedMatches"
                  : filters.search ||
                      filters.state ||
                      filters.author ||
                      filters.label ||
                      filters.view !== "all"
                    ? "noMatches"
                    : "empty",
              )}
            </p>
          )}
          {groups.map((group) => (
            <Collapsible
              key={group.key}
              open={!collapsed.includes(group.key)}
              onOpenChange={(open) =>
                setCollapsed((previous) =>
                  open
                    ? previous.filter((key) => key !== group.key)
                    : [...previous, group.key],
                )
              }
            >
              <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-xs text-muted-foreground hover:bg-control">
                {collapsed.includes(group.key) ? (
                  <ChevronRight data-icon />
                ) : (
                  <ChevronDown data-icon />
                )}
                {heading(group.key)}
                <span className="tabular-nums">{group.rows.length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul>
                  {group.rows.map((row) => {
                    const Icon = PULL_REQUEST_ICONS[row.state];
                    return (
                      <li
                        key={row.url}
                        className={cn(
                          "group flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-control",
                          selected === row.url && "bg-control",
                        )}
                      >
                        <Checkbox
                          aria-label={t("selectPull", { number: row.number })}
                          checked={checked.includes(row.url)}
                          onCheckedChange={(value) => {
                            setChecked((previous) =>
                              value
                                ? [...new Set([...previous, row.url])]
                                : previous.filter((url) => url !== row.url),
                            );
                            setCopyState(null);
                          }}
                        />
                        <Button
                          data-pull-index={ordered.indexOf(row)}
                          size="sm"
                          variant="ghost"
                          aria-pressed={selected === row.url}
                          onClick={() => select(row)}
                          className="h-auto min-w-0 flex-1 justify-start gap-2 px-0 py-2 text-start hover:bg-transparent"
                        >
                          <Icon
                            data-icon
                            aria-hidden="true"
                            className={cn(
                              "size-4 shrink-0",
                              PULL_REQUEST_COLORS[row.state],
                            )}
                          />
                          {row.author && (
                            <span
                              className="hidden shrink-0 text-xs text-muted-foreground lg:block"
                              title={row.author}
                            >
                              @{row.author}
                            </span>
                          )}
                          <bdi className="hidden max-w-48 truncate text-xs font-normal text-muted-foreground sm:block">
                            {row.repo} #{row.number}
                          </bdi>
                          <span className="min-w-0 flex-1 truncate">
                            {row.title || `${row.repo} #${row.number}`}
                          </span>
                          <span className="hidden shrink-0 text-xs font-normal text-muted-foreground lg:block">
                            {stateLabel(row)}
                          </span>
                          {row.additions !== undefined &&
                            row.deletions !== undefined && (
                              <bdi className="hidden shrink-0 gap-1.5 text-xs tabular-nums xl:flex">
                                <span className="text-github-pr-open">
                                  +{row.additions}
                                </span>
                                <span className="text-github-pr-closed">
                                  −{row.deletions}
                                </span>
                              </bdi>
                            )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t(
                            pinned.includes(githubPullRequestKey(row.url))
                              ? "unpin"
                              : "pin",
                          )}
                          aria-pressed={pinned.includes(
                            githubPullRequestKey(row.url),
                          )}
                          onClick={() => pin([row.url])}
                        >
                          <Pin
                            data-icon
                            className={cn(
                              pinned.includes(githubPullRequestKey(row.url)) &&
                                "fill-current",
                            )}
                          />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ))}
          {more && (
            <div className="flex justify-center py-3">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void (repo
                    ? github.setSize(github.size + 1)
                    : linked.setSize(linked.size + 1))
                }
              >
                {t(busy ? "loading" : "more")}
              </Button>
            </div>
          )}
          {data && (
            <p className="px-2 pt-3 text-xs text-muted-foreground">
              {t(more ? "loadedPartial" : "loaded", { count: rows.length })}
            </p>
          )}
        </div>
        {active && (
          <ResizablePane
            render="aside"
            role="region"
            aria-label={t("preview")}
            label={t("resizePreview")}
            storageKey={scope + ":width"}
            defaultWidth={400}
            min={300}
            max={720}
            edge="start"
            from="md"
            className="flex min-h-0 w-full flex-col border-s border-border bg-background md:w-96"
          >
            <div className="flex shrink-0 items-center gap-2 p-3">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {active.repo} #{active.number}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("copyLink")}
                title={t("copyLink")}
                onClick={() => void copy([active.url])}
              >
                <Copy data-icon />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("openGitHub")}
                title={t("openGitHub")}
                render={
                  <a
                    href={active.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <ExternalLink data-icon />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("closePreview")}
                title={t("closePreview")}
                onClick={() => setSelected(null)}
              >
                <X data-icon />
              </Button>
            </div>
            <PullPreview row={active} source={Boolean(repo)} />
          </ResizablePane>
        )}
      </div>
      {visibleChecked.length > 0 && (
        <div
          aria-label={t("selection")}
          className="flex flex-wrap items-center gap-2 bg-muted/50 px-4 py-2 text-sm"
        >
          <span>{t("selected", { count: visibleChecked.length })}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copy(visibleChecked.map((row) => row.url))}
          >
            {t("copyLinks")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => pin(visibleChecked.map((row) => row.url))}
          >
            {t(
              visibleChecked.every((row) =>
                pinned.includes(githubPullRequestKey(row.url)),
              )
                ? "unpin"
                : "pin",
            )}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setChecked([])}>
            {t("deselect")}
          </Button>
        </div>
      )}
      {copyState && (
        <p
          role={copyState === "copyError" ? "alert" : "status"}
          className="px-4 py-2 text-xs"
        >
          {t(copyState)}
        </p>
      )}
    </section>
  );
}

function PullPreview({
  row,
  source,
}: {
  row: PullDirectoryRow;
  source: boolean;
}) {
  const t = useTranslations("PullDirectory");
  const format = useFormatter();
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto p-4 pt-0">
      <h2 className="break-words text-lg font-semibold">
        {row.title || `${row.repo} #${row.number}`}
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={PULL_REQUEST_COLORS[row.state]}>
          {t(stateKeys[pullDirectoryState(row)])}
        </span>
        {row.author && <span>@{row.author}</span>}
        {row.additions !== undefined && row.deletions !== undefined && (
          <bdi className="flex gap-2 tabular-nums">
            <span className="text-github-pr-open">+{row.additions}</span>
            <span className="text-github-pr-closed">−{row.deletions}</span>
          </bdi>
        )}
      </div>
      {row.head && row.base && (
        <bdi className="break-all text-xs text-muted-foreground">
          {row.base} ← {row.head}
        </bdi>
      )}
      {source && (
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <dt>{t("checks")}</dt>
          <dd>{t(checkKeys[row.checks ?? "unknown"])}</dd>
          <dt>{t("review")}</dt>
          <dd>
            {t(
              reviewKeys[
                row.reviewDecision === "APPROVED" ||
                row.reviewDecision === "CHANGES_REQUESTED" ||
                row.reviewDecision === "REVIEW_REQUIRED"
                  ? row.reviewDecision
                  : "unknown"
              ],
            )}
          </dd>
          <dt>{t("updated")}</dt>
          <dd>
            <time dateTime={row.updatedAt}>
              {format.dateTime(new Date(row.updatedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
          </dd>
        </dl>
      )}
      {!source && (
        <p className="text-xs text-muted-foreground">{t("linkedSnapshot")}</p>
      )}
      {row.labels.length > 0 && (
        <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {row.labels.join(" · ")}
        </p>
      )}
      {row.body && (
        <p className="whitespace-pre-wrap break-words text-sm">{row.body}</p>
      )}
      {row.threads.length > 0 && (
        <div className="flex flex-col items-start gap-1">
          <h3 className="text-xs text-muted-foreground">{t("threads")}</h3>
          {row.threads.map((thread) => (
            <Button
              key={thread.kind + thread.id}
              variant="link"
              size="sm"
              className="h-auto max-w-full whitespace-normal text-start"
              onClick={() =>
                thread.kind === "chat"
                  ? openGroupConversation(thread.id)
                  : openThread(thread.id)
              }
            >
              {thread.title}
            </Button>
          ))}
          {[
            ...new Map(
              row.threads.flatMap((thread) =>
                thread.issueId
                  ? [
                      [
                        thread.issueId,
                        thread.identifier || thread.taskTitle || thread.title,
                      ] as const,
                    ]
                  : [],
              ),
            ).entries(),
          ].map(([id, name]) => (
            <Button
              key={id}
              size="sm"
              variant="link"
              onClick={() => openTask(id)}
            >
              {name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
