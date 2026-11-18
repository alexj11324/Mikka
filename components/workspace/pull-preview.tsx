"use client";

// The PR directory's detail. A header that says what this is and gives the one
// action it has, then two views of the same pull request: 概览 is the facts as
// a label/value table plus what points at it, 改动 is its size and where its
// diff is reviewed. Nothing here repeats the row (decision 2026-11-18-1400).
import { useState } from "react";
import { Copy, ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { compactAge } from "@/components/nav/compact-age";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  const [view, setView] = useState("overview");
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
  const diff = row.additions !== undefined && row.deletions !== undefined;

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
      <header className="flex shrink-0 flex-col gap-1 px-4 pb-2 pt-3">
        <div className="flex items-center gap-1">
          <PullRequestIcon state={row.state} />
          <bdi className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
            {row.repo} #{row.number}
          </bdi>
          {tasks[0] ? (
            <Button size="sm" variant="secondary" onClick={() => openTask(tasks[0][0])}>
              {t("openTask")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              nativeButton={false}
              render={<a href={row.url} target="_blank" rel="noopener noreferrer" />}
            >
              {t("openGitHub")}
            </Button>
          )}
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
            aria-label={t("closePreview")}
            title={t("closePreview")}
            onClick={onClose}
            className="text-muted-foreground"
          >
            <X data-icon />
          </Button>
        </div>
        <h2 className="text-md font-semibold break-words">{title}</h2>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
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
      </header>
      <Tabs value={view} onValueChange={(key) => setView(String(key))} className="min-h-0 flex-1 gap-0">
        <TabsList aria-label={t("preview")}>
          <TabsTrigger value="overview">{t("overview")}</TabsTrigger>
          <TabsTrigger value="changes">{t("changes")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex min-h-0 flex-col gap-4 overflow-auto px-4 pb-6 pt-3">
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-y-1.5 text-xs">
            {source && (
              <>
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
                <Fact label={t("branch")}>
                  {row.base && row.head ? (
                    <bdi dir="ltr" className="block break-all font-mono text-xs">
                      {row.base} ← {row.head}
                    </bdi>
                  ) : (
                    t("notReported")
                  )}
                </Fact>
                <Fact label={t("label")}>
                  {row.labels.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {row.labels.map((label) => (
                        <span key={label} className="rounded-md bg-control px-1.5 py-0.5 text-xs text-foreground">
                          {label}
                        </span>
                      ))}
                    </span>
                  ) : (
                    t("none")
                  )}
                </Fact>
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
              </>
            )}
            <Fact label={t("tasks")}>
              {tasks.length > 0 ? (
                <span className="flex flex-col items-start gap-0.5">
                  {tasks.map(([id, name]) => (
                    <Button
                      key={id}
                      variant="ghost"
                      size="sm"
                      className="h-auto -ms-1.5 px-1.5 py-0.5 text-xs font-normal"
                      aria-label={t("openTaskNamed", { name })}
                      onClick={() => openTask(id)}
                    >
                      {name}
                    </Button>
                  ))}
                </span>
              ) : (
                t("none")
              )}
            </Fact>
            <Fact label={t("threads")}>
              {row.threads.length > 0 ? (
                <span className="flex flex-col items-start gap-0.5">
                  {row.threads.map((thread) => (
                    <Button
                      key={thread.kind + thread.id}
                      variant="ghost"
                      size="sm"
                      className="h-auto -ms-1.5 max-w-full justify-start px-1.5 py-0.5 text-xs font-normal"
                      onClick={() =>
                        thread.kind === "chat" ? openGroupConversation(thread.id) : openThread(thread.id)
                      }
                    >
                      <span className="min-w-0 truncate">{thread.title}</span>
                    </Button>
                  ))}
                </span>
              ) : (
                t("none")
              )}
            </Fact>
          </dl>
          {!source && <p className="text-xs text-muted-foreground">{t("linkedSnapshot")}</p>}
          {body && (
            <section aria-label={t("description")} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">{t("description")}</h3>
              <p className={cn("whitespace-pre-wrap break-words text-sm", !expanded && "line-clamp-8")}>{body}</p>
              {body.length > 340 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-ms-2 self-start text-muted-foreground"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? t("showLess") : t("showMore")}
                </Button>
              )}
            </section>
          )}
          {copied && (
            <p
              role={copied === "copyError" ? "alert" : "status"}
              className={cn("text-xs", copied === "copyError" ? "text-destructive-foreground" : "text-muted-foreground")}
            >
              {t(copied)}
            </p>
          )}
        </TabsContent>
        <TabsContent value="changes" className="flex min-h-0 flex-col gap-3 overflow-auto px-4 pb-6 pt-3">
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-y-1.5 text-xs">
            <Fact label={t("diffSize")}>
              {diff ? (
                <bdi className="tabular-nums">
                  <span className="text-github-pr-open">+{row.additions}</span>{" "}
                  <span className="text-github-pr-closed">−{row.deletions}</span>
                </bdi>
              ) : (
                t("notReported")
              )}
            </Fact>
          </dl>
          {tasks[0] ? (
            <Button size="sm" variant="secondary" className="self-start" onClick={() => openTask(tasks[0][0])}>
              {t("openReview")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t("noLinkedTask")}</p>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="-ms-2 self-start text-muted-foreground"
            nativeButton={false}
            render={<a href={`${row.url}/files`} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLink data-icon />
            {t("openGitHub")}
          </Button>
        </TabsContent>
      </Tabs>
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
