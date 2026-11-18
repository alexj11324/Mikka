"use client";

// One pull request as a row of the PR directory: the GitHub mark and the title
// lead, the quiet line under it carries the repository, number, owner and age,
// and the derived state is the one coloured word at the row's end. The row's
// own actions (pin, open on GitHub) hold a reserved slot that stays empty until
// the pointer is on the row or focus is inside it, so a dense list stays quiet
// without moving when it wakes up (decision 2026-11-18-1400).
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pin,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { compactAge } from "@/components/nav/compact-age";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PULL_REQUEST_COLORS,
  PULL_REQUEST_ICONS,
  PULL_STATE_TONES,
} from "@/lib/pull-request-appearance";
import {
  pullDirectoryState,
  type PullDirectoryRow,
  type PullState,
} from "@/lib/pull-directory";

const stateKeys: Record<PullState, `states.${PullState}`> = {
  ready: "states.ready",
  pending: "states.pending",
  failed: "states.failed",
  draft: "states.draft",
  open: "states.open",
  merged: "states.merged",
  closed: "states.closed",
};

/** What the row's own controls need to reach. Hover and focus reveal them; a coarse pointer keeps them. */
export const ROW_ACTIONS =
  "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100";

export function PullRow({
  row,
  index,
  selected,
  checked,
  pinned,
  onSelect,
  onCheck,
  onPin,
}: {
  row: PullDirectoryRow;
  index: number;
  selected: boolean;
  checked: boolean;
  pinned: boolean;
  onSelect: (row: PullDirectoryRow) => void;
  onCheck: (url: string, next: boolean) => void;
  onPin: (url: string) => void;
}) {
  const t = useTranslations("PullDirectory");
  const age = useTranslations("Nav.age");
  const state = pullDirectoryState(row);
  const Icon = PULL_REQUEST_ICONS[row.state];
  const title = row.title || `${row.repo} #${row.number}`;
  const diff = row.additions !== undefined && row.deletions !== undefined;
  return (
    <li
      data-pull-row
      data-state={state}
      className={cn(
        "group/row relative flex items-center gap-0.5 rounded-md pe-0.5 ps-1",
        selected ? "bg-control-hover" : "hover:bg-control",
      )}
    >
      <span className="flex w-5 shrink-0 justify-center">
        <Checkbox
          aria-label={t("selectPull", { number: row.number })}
          checked={checked}
          onCheckedChange={(value) => onCheck(row.url, Boolean(value))}
          className={cn(
            ROW_ACTIONS,
            checked && "opacity-100",
          )}
        />
      </span>
      <Button
        variant="ghost"
        data-pull-index={index}
        aria-pressed={selected}
        onClick={() => onSelect(row)}
        className="h-auto min-h-12 min-w-0 flex-1 flex-col items-stretch justify-center gap-0 rounded-none px-1 py-1 text-start font-normal hover:bg-transparent"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", PULL_REQUEST_COLORS[row.state])} />
          <span data-pull-title className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
            {title}
          </span>
          <span className={PULL_STATE_TONES[state]}>
            {t(stateKeys[state])}
          </span>
        </span>
        <span data-pull-meta className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <bdi className="min-w-0 truncate">
            {row.repo} <span className="tabular-nums">#{row.number}</span>
          </bdi>
          {row.author && (
            <>
              <span aria-hidden="true" className="shrink-0 opacity-60">·</span>
              <span className="min-w-0 truncate">@{row.author}</span>
            </>
          )}
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {diff && (
              <bdi className="tabular-nums">
                <span className="text-github-pr-open">+{row.additions}</span>{" "}
                <span className="text-github-pr-closed">−{row.deletions}</span>
              </bdi>
            )}
            <span className="tabular-nums">{compactAge(row.updatedAt, Date.now(), (key, values) => age(key, values))}</span>
          </span>
        </span>
      </Button>
      <span className="flex w-14 shrink-0 justify-end">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t(pinned ? "unpin" : "pin")}
          aria-pressed={pinned}
          onClick={() => onPin(row.url)}
          className={cn(ROW_ACTIONS, "text-muted-foreground")}
        >
          <Pin data-icon className={cn(pinned && "fill-current")} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("openGitHub")}
          title={t("openGitHub")}
          nativeButton={false}
          render={<a href={row.url} target="_blank" rel="noopener noreferrer" />}
          className={cn(ROW_ACTIONS, "text-muted-foreground")}
        >
          <ExternalLink data-icon />
        </Button>
      </span>
    </li>
  );
}

/** A group's name in the list: fixed while its rows scroll under it. */
export function PullGroupHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={open}
      onClick={onToggle}
      className="sticky top-0 z-10 h-8 w-full justify-start gap-1 rounded-none bg-background px-1.5 text-xs font-medium text-muted-foreground hover:bg-background hover:text-foreground"
    >
      {open ? (
        <ChevronDown data-icon className="text-muted-foreground" />
      ) : (
        <ChevronRight data-icon className="text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{label}</span>
      <span className="text-xs font-normal tabular-nums opacity-70">{count}</span>
    </Button>
  );
}

/** The list before its rows arrive: the same two lines at the same height, so nothing jumps when they do. */
export function PullRowSkeleton() {
  return (
    <div className="flex min-h-12 items-center gap-2 ps-2 pe-1 py-1" aria-hidden="true">
      <Skeleton className="size-3.5 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}
