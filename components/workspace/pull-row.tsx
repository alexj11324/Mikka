"use client";

// One pull request as a row of the PR directory: the repository mark, the
// repository and number, the title as the lead, the diff size, the age and the
// state — one line at every width, so the same list never becomes three
// different products. The row's own actions hold a reserved slot that stays
// empty until the pointer is on the row or focus is inside it
// (decision 2026-11-18-1400, R-92…R-94).
//
// A press opens the pull request's review in the app, whichever PR it is: the
// list holds every PR the person can read, not only the ones Mikka produced
// (hooks/code-review/use-review-page.ts). GitHub stays one explicit icon away.
import { ChevronDown, ChevronRight, ExternalLink, Pin } from "lucide-react";
import { useTranslations } from "@/lib/intl/i18n-client";
import { cn } from "cn";
import { compactAge } from "@/components/nav/compact-age";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { openPullReview } from "@/hooks/code-review/use-review-page";
import {
  PULL_REQUEST_COLORS,
  PULL_REQUEST_ICONS,
  PULL_STATE_TONES,
} from "@/lib/pull-request-appearance";
import {
  pullDirectoryState,
  pullReviewRef,
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

/** Hover and keyboard focus reveal a row's own controls; a coarse pointer keeps them. */
const DISCLOSED =
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
        "group/row relative flex h-10 items-center rounded-md pe-0.5 ps-1.5",
        selected ? "bg-control-hover" : "hover:bg-control",
      )}
    >
      <span className="flex w-5 shrink-0 justify-center">
        <Checkbox
          aria-label={t("selectPull", { number: row.number })}
          checked={checked}
          onCheckedChange={(value) => onCheck(row.url, Boolean(value))}
          className={cn(DISCLOSED, checked && "opacity-100")}
        />
      </span>
      <Button
        variant="ghost"
        data-pull-index={index}
        aria-pressed={selected}
        onClick={() => {
          onSelect(row);
          const pull = pullReviewRef(row);
          if (pull) openPullReview(pull);
        }}
        className="h-full min-w-0 flex-1 flex-row items-center justify-start gap-2 rounded-none px-1 text-start font-normal hover:bg-transparent"
      >
        <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", PULL_REQUEST_COLORS[row.state])} />
        <bdi className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground tabular-nums sm:block">
          {row.repo}{" "}
          <span className="text-muted-foreground">#{row.number}</span>
        </bdi>
        <span data-pull-title className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
          {title}
        </span>
        {diff && (
          <bdi className="shrink-0 text-xs tabular-nums">
            <span className="text-github-pr-open">+{row.additions}</span>{" "}
            <span className="text-github-pr-closed">−{row.deletions}</span>
          </bdi>
        )}
        <span className="w-10 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
          {compactAge(row.updatedAt, Date.now(), (key, values) => age(key, values))}
        </span>
        <span className={cn("w-12 shrink-0 text-end text-xs font-medium", PULL_STATE_TONES[state])}>
          {t(stateKeys[state])}
        </span>
      </Button>
      <span className="flex w-14 shrink-0 justify-end">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t(pinned ? "unpin" : "pin")}
          aria-pressed={pinned}
          onClick={() => onPin(row.url)}
          className={cn(DISCLOSED, "text-muted-foreground")}
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
          className={cn(DISCLOSED, "text-muted-foreground")}
        >
          <ExternalLink data-icon />
        </Button>
      </span>
    </li>
  );
}

/** A group's name and count, fixed while its rows scroll under it. */
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

/** The list before its rows arrive: the height of the row it replaces. */
export function PullRowSkeleton() {
  return (
    <div className="flex h-10 items-center gap-2 ps-2 pe-1" aria-hidden="true">
      <Skeleton className="size-3.5 shrink-0 rounded-full" />
      <Skeleton className="h-3.5 w-2/3" />
    </div>
  );
}
