"use client";

// The PR directory's detail: what a pull request is, whether it can go in, and
// what already points at it. The title leads; one line under it carries the
// derived state, the owner and the age; then the facts as a label/value table
// so a column of them scans instead of reading as a sentence; then the
// description and the work it belongs to. Nothing here repeats the list row
// (decision 2026-11-18-1400).
import { useState } from "react";
import { Copy, ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { compactAge } from "@/components/nav/compact-age";
import { Button } from "@/components/ui/button";
import { PULL_STATE_TONES } from "@/lib/pull-request-appearance";
import { pullDirectoryState, type PullDirectoryRow, type PullState } from "@/lib/pull-directory";
import { openGroupConversation, openTask, openThread } from "./workspace-navigation";
import { PullRequestIcon } from "./pull-request-icon";

const stateKeys: Record<PullState, `states.${PullState}`> = {
  ready: "states.ready",
  pending: "states.pending",
  failed: "states.failed",
  draft: "states.draft",
  open: "states.open",
  merged: "states.merged",
  closed: "states.closed",
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
type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "unknown";
const reviewKeys: Record<ReviewState, `reviewState.${ReviewState}`> = {
  APPROVED: "reviewState.APPROVED",
  CHANGES_REQUESTED: "reviewState.CHANGES_REQUESTED",
  REVIEW_REQUIRED: "reviewState.REVIEW_REQUIRED",
  unknown: "reviewState.unknown",
};
export function PullPreview({
  row,
  source,
  onClose,
}: {
  row: PullDirectoryRow;
  source: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("PullDirectory");
  const age = useTranslations("Nav.age");
  const [copied, setCopied] = useState<"copied" | "copyError" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const state = pullDirectoryState(row);
  const title = row.title || `${row.repo} #${row.number}`;
  const tasks = [
    ...new Map(
      row.threads.flatMap((thread) =>
        thread.issueId
          ? ([[thread.issueId, thread.identifier || thread.taskTitle || thread.title]] as const)
          : [],
      ),
    ).entries(),
  ];
  const review = row.reviewDecision;
  const body = row.body?.trim() ?? "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopied("copied");
    } catch {
      setCopied("copyError");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 pe-2 ps-4">
        <PullRequestIcon state={row.state} />
        <bdi className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
          {row.repo} #{row.number}
        </bdi>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("copyLink")}
          title={t("copyLink")}
          onClick={() => void copy()}
          className="text-muted-foreground"
        >
          <Copy data-icon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("openGitHub")}
          title={t("openGitHub")}
          nativeButton={false}
          render={<a href={row.url} target="_blank" rel="noopener noreferrer" />}
          className="text-muted-foreground"
        >
          <ExternalLink data-icon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("closePreview")}
          title={t("closePreview")}
          onClick={onClose}
          className="text-muted-foreground"
        >
          <X data-icon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        <h2 className="text-md font-semibold break-words">{title}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span className={PULL_STATE_TONES[state]}>{t(stateKeys[state])}</span>
          {row.author && (
            <>
              <span aria-hidden="true" className="text-muted-foreground opacity-60">·</span>
              <span className="text-muted-foreground">@{row.author}</span>
            </>
          )}
          <span aria-hidden="true" className="text-muted-foreground opacity-60">·</span>
          <span className="text-muted-foreground tabular-nums">
            {compactAge(row.updatedAt, Date.now(), (key, values) => age(key, values))}
          </span>
        </p>
        {tasks.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {tasks.map(([id, name]) => (
              <Button
                key={id}
                size="sm"
                variant="secondary"
                aria-label={t("openTaskNamed", { name })}
                onClick={() => openTask(id)}
              >
                {t("openTask")}
                <span className="max-w-40 truncate text-muted-foreground">{name}</span>
              </Button>
            ))}
          </div>
        )}
        {source ? (
          <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-y-1.5 text-xs">
            <Fact label={t("checks")}>{t(checkKeys[row.checks ?? "unknown"])}</Fact>
            <Fact label={t("review")}>
              {t(
                reviewKeys[
                  review === "APPROVED" || review === "CHANGES_REQUESTED" || review === "REVIEW_REQUIRED"
                    ? review
                    : "unknown"
                ],
              )}
            </Fact>
            {row.base && row.head && (
              <Fact label={t("branch")}>
                <bdi dir="ltr" className="block break-all font-mono text-xs">
                  {row.base} ← {row.head}
                </bdi>
              </Fact>
            )}
            <Fact label={t("updated")}>
              <time dateTime={row.updatedAt} className="tabular-nums">
                {new Date(row.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </Fact>
            {row.labels.length > 0 && (
              <Fact label={t("label")}>
                <span className="flex flex-wrap gap-1">
                  {row.labels.map((label) => (
                    <span key={label} className="rounded-md bg-control px-1.5 py-0.5 text-xs text-foreground">
                      {label}
                    </span>
                  ))}
                </span>
              </Fact>
            )}
          </dl>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">{t("linkedSnapshot")}</p>
        )}
        {body && (
          <section aria-label={t("description")} className="mt-5">
            <h3 className="sr-only">{t("description")}</h3>
            <p className={cn("whitespace-pre-wrap break-words text-sm", !expanded && "line-clamp-6")}>{body}</p>
            {body.length > 280 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 -ms-2 text-muted-foreground"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? t("showLess") : t("showMore")}
              </Button>
            )}
          </section>
        )}
        {row.threads.length > 0 && (
          <section aria-label={t("threads")} className="mt-5">
            <h3 className="text-xs font-medium text-muted-foreground">{t("threads")}</h3>
            <ul className="mt-1 flex flex-col">
              {row.threads.map((thread) => (
                <li key={thread.kind + thread.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start px-0 py-1 text-start text-sm font-normal"
                    onClick={() =>
                      thread.kind === "chat" ? openGroupConversation(thread.id) : openThread(thread.id)
                    }
                  >
                    <span className="min-w-0 truncate">{thread.title}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {copied && (
          <p
            role={copied === "copyError" ? "alert" : "status"}
            className={cn("mt-3 text-xs", copied === "copyError" ? "text-destructive-foreground" : "text-muted-foreground")}
          >
            {t(copied)}
          </p>
        )}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}
