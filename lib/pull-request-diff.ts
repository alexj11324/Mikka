/**
 * A pull request's changed files, put back into the `git diff` text the review page
 * reads (lib/thread-changes.ts). GitHub's REST files endpoint returns a bare hunk
 * set per file — no `diff --git` header, no status line — so this writes the header
 * `parseUnifiedDiff` needs before it sees it. Nothing here touches GitHub.
 */

/** One file as GitHub's files endpoint reports it, already narrowed to what the diff needs. */
export interface PullFileEntry {
  path: string
  /** The old path of a renamed file. */
  previousPath: string | null
  status: "added" | "modified" | "deleted" | "renamed"
  /** GitHub leaves this out for binary files and for a diff it truncated: the file lists but draws no lines. */
  patch: string | null
}

export function pullRequestDiffText(files: readonly PullFileEntry[]): string {
  const out: string[] = [];
  for (const file of files) {
    const from = file.previousPath ?? file.path;
    out.push(`diff --git a/${from} b/${file.path}`);
    if (file.status === "added") out.push("new file mode 100644");
    else if (file.status === "deleted") out.push("deleted file mode 100644");
    else if (file.status === "renamed" && file.previousPath)
      out.push(`rename from ${file.previousPath}`, `rename to ${file.path}`);
    // A file with no patch is one the parser can only draw as binary, which is
    // what a missing hunk set looks like: it keeps its row and offers no lines.
    out.push(file.patch ?? `Binary files a/${from} and b/${file.path} differ`);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
