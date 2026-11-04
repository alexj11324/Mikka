"use client";

// Code diffs on the web are drawn by Pierre's @pierre/diffs (Apache-2.0) with its
// own look and themes. Mikka only picks light or dark and gives it the full width.
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff as PierreFileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata, FileDiffOptions } from "@pierre/diffs/react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
  type?: FileDiffLineType;
  content: string;
}

/** Follows Mikka's light or dark mode; the system's until the theme is known. */
export function useDiffThemeType(): "light" | "dark" | "system" {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark" ? "dark" : resolvedTheme === "light" ? "light" : "system";
}

/**
 * The options every Mikka diff shares: the library's themes, stacked lines (a
 * side-by-side view has no room in a chat or a side panel), and a plain
 * separator between hunks, since the library's "N unmodified lines" is English only.
 */
export function useDiffOptions({ overflow = "wrap", collapsed = false, stickyHeader = false }: Pick<FileDiffOptions<undefined, undefined>, "overflow" | "collapsed" | "stickyHeader"> = {}): FileDiffOptions<undefined, undefined> {
  const themeType = useDiffThemeType();
  return useMemo(() => ({ themeType, diffStyle: "unified", hunkSeparators: "simple", overflow, collapsed, stickyHeader }), [collapsed, overflow, stickyHeader, themeType]);
}

/** One hunk from lines that start at line 1 on both sides, as a unified patch. */
export function linesToPatch(file: string, lines: FileDiffLine[]): string {
  const oldCount = lines.filter((line) => line.type !== "added").length;
  const newCount = lines.filter((line) => line.type !== "removed").length;
  const body = lines.map((line) => (line.type === "added" ? "+" : line.type === "removed" ? "-" : " ") + line.content);
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@`, ...body, ""].join("\n");
}

/** The code after the change: what 复制 puts on the clipboard. */
export function newSideText(lines: FileDiffLine[]): string {
  return lines.filter((line) => line.type !== "removed").map((line) => line.content).join("\n");
}

export interface FileDiffProps {
  file: string;
  lines: FileDiffLine[];
  status?: FileDiffStatus;
  /** A Shiki language; inferred from the file name when left out. */
  language?: string;
  copyLabel?: string;
  copiedLabel?: string;
  className?: string;
}

export function FileDiff({ file, lines, status = "streaming", language, copyLabel = "Copy code", copiedLabel = "Copied", className }: FileDiffProps) {
  const streaming = status === "streaming";
  const patch = useMemo(() => linesToPatch(file, lines), [file, lines]);
  const fileDiff = useMemo<FileDiffMetadata>(() => {
    const parsed = getSingularPatch(patch);
    return language ? { ...parsed, lang: language } : parsed;
  }, [language, patch]);
  const options = useDiffOptions();
  const copyText = useMemo(() => newSideText(lines), [lines]);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const copy = useCallback(async () => {
    await navigator.clipboard?.writeText(copyText);
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [copyText]);

  return (
    <div role="group" aria-label={file} data-state={status} aria-busy={streaming} data-slot="file-diff" className={className ?? "w-full min-w-0"}>
      <PierreFileDiff
        fileDiff={fileDiff}
        options={options}
        disableWorkerPool
        renderHeaderMetadata={() => (
          <span className="flex items-center gap-1">
            {streaming ? (
              <LoaderCircle aria-label="Applying changes" className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
            ) : (
              <Check aria-label="Changes applied" className="size-3.5 text-muted-foreground" />
            )}
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={copied ? copiedLabel : copyLabel} title={copied ? copiedLabel : copyLabel} onClick={() => { void copy(); }}>
              {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            </Button>
          </span>
        )}
      />
    </div>
  );
}
