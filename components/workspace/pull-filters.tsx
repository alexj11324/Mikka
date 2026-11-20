"use client";

// The PR directory's one filter row, arranged as Capy's is: the search, the
// conditions that are on as chips you can remove where you read them, the
// group-by control, and a quiet ⋯ for refresh, the reading views and the saved
// views (decision 2026-11-18-1400; Alex, 2026-11-18 「你应该跟他修成一样的才对吧」).
// The reading view is a condition too, so it shows as the leading chip instead
// of hiding in the tab alone.
// The row stays one family, as the board's toolbar and 自动化's are: the search
// and the group-by control take a `--control` fill with no stroke, the group-by
// selection is the row's one filled segment (R-31), and every action beside them
// is ghost until it is on (R-99: one step, 28px, for the whole row — the search
// names `h-(--control-sm)` because the size policy reads the call site, not the
// component's own default).
import { useState } from "react";
import { Bookmark, Plus, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { useTranslations } from "@/lib/intl/i18n-client";
import { cn } from "cn";
import { withBasePath } from "@/lib/base-path";
import {
  pullGroups,
  pullStates,
  pullViewStates,
  type PullFilters,
  type PullGroup,
  type PullState,
  type SavedPullView,
} from "@/lib/pull-directory";
import { Button } from "@/components/ui/button";
import { FilterChip } from "@/components/ui/filter-chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const stateKeys: Record<PullState, `states.${PullState}`> = {
  ready: "states.ready",
  attention: "states.attention",
  pending: "states.pending",
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
/** The grouping a segmented control reports back, read against the list it was built from. */
const groupingValue = (value: string | undefined) =>
  pullGroups.find((group) => group === value);

/** One condition, read the way Capy reads it: the property, the operator, the
 *  value, and a × that drops just this one. A condition with nothing to compare
 *  — "Linked only" — is one phrase rather than an empty value. */
type Chip = {
  key: string;
  property: string;
  value?: string;
  title?: string;
  clear: Partial<PullFilters>;
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
  authors,
  labels,
  total,
  shown,
  busy,
  views,
  searchRef,
  onChange,
  onGrouping,
  onRefresh,
  onApplyView,
  onDeleteView,
  onSaveView,
}: {
  filters: PullFilters;
  grouping: PullGroup;
  repo: string;
  authors: string[];
  labels: string[];
  total: number;
  shown: number;
  busy: boolean;
  views: SavedPullView[];
  searchRef: React.RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<PullFilters>) => void;
  onGrouping: (grouping: PullGroup) => void;
  onRefresh: () => void;
  onApplyView: (view: SavedPullView) => void;
  onDeleteView: (name: string) => void;
  onSaveView: () => void;
}) {
  const t = useTranslations("PullDirectory");
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const active = activeFilterCount(filters, repo);
  const admitted = pullViewStates(filters.view);
  const chips: Chip[] = [];
  // The reading view is itself a state condition, so it leads the row; an
  // explicit state filter replaces it rather than stacking a second one.
  if (admitted.length && !filters.state)
    chips.push({
      key: "view",
      property: t("state"),
      value:
        admitted.length === 1
          ? t(stateKeys[admitted[0]])
          : t("eitherOfStates", { count: admitted.length }),
      title: admitted.map((state) => t(stateKeys[state])).join(" · "),
      clear: { view: "all", state: "" },
    });
  if (filters.state)
    chips.push({
      key: "state",
      property: t("state"),
      value: t(stateKeys[filters.state]),
      clear: { state: "" },
    });
  if (repo && filters.author)
    chips.push({
      key: "author",
      property: t("author"),
      value: filters.author,
      clear: { author: "" },
    });
  if (repo && filters.label)
    chips.push({
      key: "label",
      property: t("label"),
      value: filters.label,
      clear: { label: "" },
    });
  if (filters.linked)
    chips.push({
      key: "linked",
      property: t("linkedOnly"),
      clear: { linked: false },
    });
  return (
    <div className="flex flex-col gap-2 px-4 pb-2">
      {/* control-size-exempt: the row's 24px control is the remove-view icon inside a saved-view menu row, not a peer of the 28px toolbar controls beside it. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FieldGroup className="min-w-44 max-w-96 flex-1">
          <Field className="gap-0">
            <SearchInput
              ref={searchRef}
              value={filters.search}
              maxLength={120}
              aria-label={t("search")}
              placeholder={t("search")}
              className="h-(--control-sm)"
              onChange={(event) => onChange({ search: event.target.value })}
            />
          </Field>
        </FieldGroup>
        <Popover open={conditionsOpen} onOpenChange={setConditionsOpen}>
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
            {active > 0 && <span className="tabular-nums">{active}</span>}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 gap-3 p-3">
            <PopoverHeader>
              <PopoverTitle>{t("filter")}</PopoverTitle>
            </PopoverHeader>
            <div className="flex flex-col gap-2.5">
              <ConditionRow label={t("state")}>
                <NativeSelect
                  size="sm"
                  aria-label={t("state")}
                  value={filters.state}
                  // A chosen state replaces the reading view's own condition, so
                  // the view steps back to 全部 instead of claiming a filter the
                  // list no longer applies.
                  onChange={(event) => {
                    const state = event.target.value as PullFilters["state"];
                    onChange(state ? { state, view: "all" } : { state: "" });
                  }}
                  className="w-full"
                >
                  <NativeSelectOption value="">{t("anyState")}</NativeSelectOption>
                  {pullStates.map((state) => (
                    <NativeSelectOption key={state} value={state}>
                      {t(stateKeys[state])}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </ConditionRow>
              {repo && (
                <>
                  <ConditionRow label={t("author")}>
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
                  </ConditionRow>
                  <ConditionRow label={t("label")}>
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
                  </ConditionRow>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={!active}
                onClick={() => {
                  onChange({ state: "", author: "", label: "", linked: false });
                  setConditionsOpen(false);
                }}
              >
                {t("clearFilters")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConditionsOpen(false)}>
                {t("done")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <ToggleGroup
          aria-label={t("grouping")}
          size="sm"
          variant="segment"
          spacing={0.5}
          value={[grouping]}
          onValueChange={(values) => {
            const next = groupingValue(values[0]);
            if (next) onGrouping(next);
          }}
        >
          {pullGroups.map((group) => (
            <ToggleGroupItem key={group} value={group}>
              {t(groupKeys[group])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="ms-auto text-xs tabular-nums text-muted-foreground">
          {shown === total ? t("countAll", { count: total }) : t("countShown", { shown, count: total })}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("moreActions")}
                title={t("moreActions")}
                className="text-muted-foreground"
              />
            }
          >
            <Bookmark data-icon className={cn(views.length > 0 && "fill-current")} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onRefresh} disabled={busy}>
                <RefreshCw data-icon className={cn(busy && "animate-spin")} />
                {t("refresh")}
              </DropdownMenuItem>
              {repo && (
                <DropdownMenuItem
                  render={<a href={`https://github.com/${repo}/compare`} target="_blank" rel="noopener noreferrer" />}
                >
                  <Plus data-icon />
                  {t("newPull")}
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
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
              <DropdownMenuItem onClick={onSaveView}>{t("saveView")}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {chips.length > 0 && (
        <div data-pull-conditions className="flex flex-wrap items-center gap-1">
          {chips.map((chip) => (
            <FilterChip
              key={chip.key}
              field={chip.property}
              value={chip.value}
              is={t('is')}
              title={chip.title}
              removeLabel={t('removeFilter', {
                name: chip.value === undefined ? chip.property : `${chip.property} ${chip.value}`,
              })}
              onRemove={() => onChange(chip.clear)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConditionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** The GitHub connection the repository view needs, said once where the list would be. */
export function PullConnectState({
  error,
  busy,
  onRetry,
}: {
  error: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("PullDirectory");
  return (
    <div role="status" className="mx-4 mt-6 flex flex-col items-start gap-3 rounded-xl bg-control px-4 py-4">
      <p className="text-sm text-foreground">{t(error ? "repositoryError" : "connectGitHub")}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          nativeButton={false}
          render={<a href={withBasePath("/?settings=integrations")} />}
        >
          {t("connections")}
        </Button>
        {error && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>
            {t("retry")}
          </Button>
        )}
      </div>
    </div>
  );
}
