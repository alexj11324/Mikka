import 'server-only'
import { CommandExitError, TimeoutError } from 'e2b'
import { connectComputer } from '@/lib/computer/e2b-provider'

export type RunActionOutput = (stream: 'stdout' | 'stderr', text: string) => void

export type RunActionCommand = {
  pid: number | null
  wait(): Promise<{ exitCode: number | null; timedOut: boolean }>
  kill(): Promise<void>
}

/** The one provider capability a run action needs. Tests substitute this. */
export interface RunActionBackend {
  start(input: {
    workspaceId: string
    sandboxId: string
    cwd: string
    command: string
    timeoutMs: number
    signal: AbortSignal
    onOutput: RunActionOutput
  }): Promise<RunActionCommand>
}

/**
 * Runs a user command in the run's own E2B task machine as the unprivileged
 * `user`, in the run's worktree. No task Secret, identity or credential is
 * added to its environment; output is masked by the runner before storage.
 */
export const e2bRunActionBackend: RunActionBackend = {
  async start(input) {
    const sandbox = await connectComputer(input.workspaceId, input.sandboxId, input.signal)
    const handle = await sandbox.commands.run(input.command, {
      background: true,
      cwd: input.cwd,
      user: 'user',
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onStdout: data => input.onOutput('stdout', data),
      onStderr: data => input.onOutput('stderr', data),
    })
    let killed = false
    const kill = async () => {
      if (killed) return
      killed = true
      await handle.kill().catch(() => false)
    }
    input.signal.addEventListener('abort', () => { void kill() }, { once: true })
    return {
      pid: Number.isInteger(handle.pid) ? handle.pid : null,
      async wait() {
        try {
          const result = await handle.wait()
          return { exitCode: result.exitCode, timedOut: false }
        } catch (error) {
          if (error instanceof TimeoutError) return { exitCode: null, timedOut: true }
          if (error instanceof CommandExitError) return { exitCode: error.exitCode, timedOut: false }
          throw error
        } finally { await handle.disconnect().catch(() => undefined) }
      },
      kill,
    }
  },
}

/** Cross-instance cancel: the command's pid is recorded with its sandbox. */
export async function killSandboxProcess(workspaceId: string, sandboxId: string, pid: number): Promise<boolean> {
  const sandbox = await connectComputer(workspaceId, sandboxId)
  return sandbox.commands.kill(pid)
}
