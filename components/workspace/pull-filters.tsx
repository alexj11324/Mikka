"use client";

// The PR directory's bar: what is being read (linked snapshots or one
// repository), which slice of it, and the filters that narrow it. The views are
// always on screen because they are how you read a PR queue; the filters that
// only some people need at a time live behind 筛选, which says how many are on
// (decision 2026-11-18-1400).
import { useState } from "react";
import { Bookmark, Plus, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { withBasePath } from "@/lib/base-path";
import {
  pullGroups,
  pullStates,
  pullViews,
  type PullFilters,
  type PullGroup,
  type PullState,
  type SavedPullView,
} from "@/lib/pull-directory";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

export function activeFilterCount(filters: PullFilters, repo: string) {
  return [
    filters.state,
    repo ? filters.author : "",
    repo ? filters.label : "",
    filters.linked ? "linked" : "",
  ].filter(Boolean).length;
}

export function PullFilterBar({
  filters,
  grouping,
  repo,
  repositories,
  repositoryError,
  authors,
  labels,
  total,
  shown,
  busy,
  searchRef,
  onChange,
  onRepo,
  onGrouping,
  onRefresh,
  onRetryRepositories,
  views,
  onApplyView,
  onDeleteView,
  onSaveView,
}: {
  filters: PullFilters;
  grouping: PullGroup;
  repo: string;
  repositories: string[];
  repositoryError: boolean;
  authors: string[];
  labels: string[];
  total: number;
  shown: number;
  busy: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<PullFilters>) => void;
  onRepo: (repo: string) => void;
  onGrouping: (grouping: PullGroup) => void;
  onRefresh: () => void;
  onRetryRepositories: () => void;
  views: SavedPullView[];
  onApplyView: (view: SavedPullView) => void;
  onDeleteView: (name: string) => void;
  onSaveView: () => void;
}) {
  const t = useTranslations("PullDirectory");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const active = activeFilterCount(filters, repo);
  return (
    <header className="flex flex-col gap-2 px-4 pt-4 pb-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="me-1 text-md font-semibold">{t("title")}</h1>
        <span className="text-xs tabular-nums text-muted-foreground">
          {shown === total ? t("countAll", { count: total }) : t("countShown", { shown, count: total })}
        </span>
        <Tabs
          value={filters.view}
          onValueChange={(value) =>
            onChange({ view: value as PullFilters["view"], state: "" })
          }
          className="ms-auto"
        >
          <TabsList variant="line" aria-label={t("viewLabel")}>
            {pullViews.map((view) => (
              <TabsTrigger key={view} value={view}>
                {t(viewKeys[view])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label={t("source")}
          value={repo}
          onChange={(event) => onRepo(event.target.value)}
          className="max-w-56"
        >
          <NativeSelectOption value="">{t("linkedPulls")}</NativeSelectOption>
          {repo && !repositories.includes(repo) && (
            <NativeSelectOption value={repo}>{repo}</NativeSelectOption>
          )}
          {repositories.map((fullName) => (
            <NativeSelectOption key={fullName} value={fullName}>
              {fullName}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldGroup className="min-w-40 max-w-72 flex-1">
          <Field className="gap-0">
            <SearchInput
              ref={searchRef}
              value={filters.search}
              maxLength={120}
              aria-label={t("search")}
              placeholder={t("search")}
              className="h-7"
              onChange={(event) => onChange({ search: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger
            render={
              <Button
                variant={active ? "secondary" : "ghost"}
                size="sm"
                className="gap-1.5 text-muted-foreground data-[active]:text-foreground"
                data-active={active ? true : undefined}
                aria-label={t("filters", { count: active })}
              />
            }
          >
            <SlidersHorizontal data-icon />
            {t("filter")}
            {active > 0 && (
              <span className="tabular-nums">{active}</span>
            )}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 gap-3 p-3">
            <PopoverHeader>
              <PopoverTitle>{t("filter")}</PopoverTitle>
            </PopoverHeader>
            <div className="flex flex-col gap-2.5">
              <FilterRow label={t("state")}>
                <NativeSelect
                  size="sm"
                  aria-label={t("state")}
                  value={filters.state}
                  onChange={(event) =>
                    onChange({ state: event.target.value as PullFilters["state"] })
                  }
                  className="w-full"
                >
                  <NativeSelectOption value="">{t("anyState")}</NativeSelectOption>
                  {pullStates.map((state) => (
                    <NativeSelectOption key={state} value={state}>
                      {t(stateKeys[state])}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FilterRow>
              {repo && (
                <>
                  <FilterRow label={t("author")}>
                    <NativeSelect
                      size="sm"
                      aria-label={t("author")}
                      value={filters.author}
                      onChange={(event) => onChange({ author: event.target.value })}
                      className="w-full"
                      disabled={!authors.length}
                    >
                      <NativeSelectOption value="">{t("anyAuthor")}</NativeSelectOption>
                      {authors.map((author) => (
                        <NativeSelectOption key={author} value={author}>
                          {author}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </FilterRow>
                  <FilterRow label={t("label")}>
                    <NativeSelect
                      size="sm"
                      aria-label={t("label")}
                      value={filters.label}
                      onChange={(event) => onChange({ label: event.target.value })}
                      className="w-full"
                      disabled={!labels.length}
                    >
                      <NativeSelectOption value="">{t("anyLabel")}</NativeSelectOption>
                      {labels.map((label) => (
                        <NativeSelectOption key={label} value={label}>
                          {label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </FilterRow>
                </>
              )}
              <FilterRow label={t("grouping")}>
                <NativeSelect
                  size="sm"
                  aria-label={t("grouping")}
                  value={grouping}
                  onChange={(event) => onGrouping(event.target.value as PullGroup)}
                  className="w-full"
                >
                  {pullGroups.map((group) => (
                    <NativeSelectOption key={group} value={group}>
                      {t(groupKeys[group])}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FilterRow>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={!active}
                onClick={() => {
                  onChange({ state: "", author: "", label: "", linked: false });
                  setFiltersOpen(false);
                }}
              >
                {t("clearFilters")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}>
                {t("done")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {repo && (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            nativeButton={false}
            render={
              <a href={`https://github.com/${repo}/compare`} target="_blank" rel="noopener noreferrer" />
            }
          >
            <Plus data-icon />
            <span className="max-sm:sr-only">{t("newPull")}</span>
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("refresh")}
          title={t("refresh")}
          disabled={busy}
          onClick={onRefresh}
          className="text-muted-foreground"
        >
          <RefreshCw data-icon className={cn(busy && "animate-spin")} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("viewsMenu", { count: views.length })}
                title={t("savedViews")}
                className={cn("text-muted-foreground", views.length > 0 && "text-foreground")}
              />
            }
          >
            <Bookmark data-icon className={cn(views.length > 0 && "fill-current")} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("savedViews")}</DropdownMenuLabel>
              {views.map((view) => (
                <DropdownMenuItem key={view.name} onClick={() => onApplyView(view)}>
                  <span className="flex-1 truncate">{view.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("deleteView", { name: view.name })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteView(view.name);
                    }}
                  >
                    <X data-icon />
                  </Button>
                </DropdownMenuItem>
              ))}
              {views.length === 0 && (
                <p className="px-1.5 py-1 text-xs text-muted-foreground">{t("noSavedViews")}</p>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onSaveView}>{t("saveView")}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {repositoryError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t("repositoryError")}
          <Button size="sm" variant="ghost" onClick={onRetryRepositories}>
            {t("retry")}
          </Button>
          <Button size="sm" variant="link" render={<a href={withBasePath("/?settings=integrations")} />}
            nativeButton={false}>
            {t("connections")}
          </Button>
        </div>
      )}
    </header>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** The filters that are on, each removable where it is read. */
export function PullFilterChips({
  filters,
  onChange,
}: {
  filters: PullFilters;
  onChange: (patch: Partial<PullFilters>) => void;
}) {
  const t = useTranslations("PullDirectory");
  const chips: { key: string; label: string; clear: Partial<PullFilters> }[] = [];
  if (filters.state)
    chips.push({ key: "state", label: t("stateValue", { value: t(stateKeys[filters.state]) }), clear: { state: "" } });
  if (filters.author)
    chips.push({ key: "author", label: t("authorValue", { value: filters.author }), clear: { author: "" } });
  if (filters.label)
    chips.push({ key: "label", label: t("labelValue", { value: filters.label }), clear: { label: "" } });
  if (filters.linked) chips.push({ key: "linked", label: t("linkedOnly"), clear: { linked: false } });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-0.5 rounded-md bg-control ps-2 pe-0.5 text-xs text-foreground"
        >
          {chip.label}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("removeFilter", { name: chip.label })}
            onClick={() => onChange(chip.clear)}
            className="text-muted-foreground"
          >
            <X data-icon />
          </Button>
        </span>
      ))}
    </div>
  );
}
