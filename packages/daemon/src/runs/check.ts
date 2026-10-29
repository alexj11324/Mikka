// Daemon-owned receipt for the existing read-only check. Agent reports cannot set it.
import { execa } from "execa"
import { worktreeGitDir } from "../agents/publish"

export async function fixedCheckSnapshot(
  repoPath: string,
  worktree: string,
  sha: string
) {
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Check requires an exact candidate SHA")
  const gitDir = await worktreeGitDir(repoPath, worktree)
  const git = async (...args: string[]) =>
    (
      await execa(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          cwd: worktree,
          env: { GIT_DIR: gitDir, GIT_WORK_TREE: worktree },
          stdin: "ignore",
        }
      )
    ).stdout.trim()
  if ((await git("rev-parse", "HEAD")) !== sha)
    throw new Error("Check worktree HEAD differs from the fixed candidate")
  if (await git("status", "--porcelain"))
    throw new Error(
      "Check worktree contains changes outside the fixed candidate"
    )
  return { sha, tree: await git("rev-parse", `${sha}^{tree}`) }
}
