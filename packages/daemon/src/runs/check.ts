// Daemon-owned receipt for the existing read-only check. Agent reports cannot set it.
import { readVerificationReceipt } from '@mikka/protocol/run'
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


/** Only adapter-observed executions may select an inferred post-submit command.
 * Criterion annotations and other tools' prose never grant shell execution. */
export class CheckCommandEvidence {
  private calls = new Map<string,{command:string;host:boolean}>()
  private executed = new Set<string>()
  constructor(private readonly sha: string) {}
  observe(chunk: import('../chunks').RunChunk) {
    if(chunk.type==='tool-input-available') {
      const name=chunk.toolName.toLowerCase()
      if(!['bash','shell','mcp__mikka__verify_command'].includes(name) || this.calls.size>=1000)return
      const input=chunk.input && typeof chunk.input==='object' ? chunk.input as Record<string,unknown> : null
      if(typeof input?.command==='string' && input.command.trim() && input.command.length<=4000)this.calls.set(chunk.toolCallId,{command:input.command.trim(),host:name==='mcp__mikka__verify_command'})
      return
    }
    if(chunk.type!=='tool-output-available' && chunk.type!=='tool-output-error')return
    const call=this.calls.get(chunk.toolCallId);this.calls.delete(chunk.toolCallId)
    if(!call || chunk.type!=='tool-output-available' || this.executed.size>=200)return
    if(call.host) {
      const actual=readVerificationReceipt(chunk.output)
      if(!actual || actual.sha!==this.sha || actual.command!==call.command)return
    }
    this.executed.add(call.command)
  }
  has(command: string) { return this.executed.has(command.trim()) }
}
