# Threads are private; device threads run in a sandbox from remote main

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「永远只能自己看，必须从远端的 main 上开新分支走沙盒，不允许在本地上面改」
- Rule: R-62
- Superseded in part by: [2026-11-01-2300-thread-visibility-follows-warp](2026-11-01-2300-thread-visibility-follows-warp.md) (rule 1: thread visibility follows Warp Factories; rule 2: the base is the remote default branch, or another pushed remote branch when needed, never only `main`)
- Replaces: the Open rows of `decisions.md` dated 2026-10-28 on device threads (remote-only repositories; uncommitted changes) and on who sees a thread's captures

1. ~~**Only the person who started a thread can see it.**~~ Superseded by [2300](2026-11-01-2300-thread-visibility-follows-warp.md). Other members of the
   workspace see 「<人> 的线程」, its status and time, and cannot open it.
   Its content, captures included, is the owner's alone. R-62 stays private.
2. **A thread on a person's own computer starts a new branch from the remote
   ~~`main`~~ default branch, or another pushed remote branch when needed
   ([2300](2026-11-01-2300-thread-visibility-follows-warp.md))** and runs in a sandbox, an isolated worktree. It never edits the
   person's local checkout and never sees their uncommitted changes. A
   repository with no remote is not supported; to bring in local work, the
   person commits and pushes it first.
