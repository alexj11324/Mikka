import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { HarnessInfo, NativeCoordinatorJob } from "@mikka/protocol"
import type { ServerLink } from "../server-link"
import type { Logger } from "../log"
import { buildChildEnv } from "../env"
import { spawnCli } from "../agents/child"
import { prepareCodexHome } from "../agents/harness-home"
import { jsonlConnection } from "../agents/jsonl-rpc"
import { HARNESS_DOMAINS, credentialDenyRead, daemonSecrets } from "../agents/run-context"
import type { AgentSandbox } from "../agents/sandbox"
import { runClaudeCoordinator } from "./claude"
import { CODEX_COORDINATOR_APPROVAL_POLICY, runCodexCoordinator } from "./codex"
import type { CoordinatorTool } from "./contract"

export function coordinatorCapable(info: HarnessInfo): boolean {
  if (!info.installed) return false
  if (info.harness === "claude_code") return true
  if (info.harness !== "codex") return false
  const version = info.version?.match(/(\d+)\.(\d+)\.(\d+)/)
  return Boolean(version && (Number(version[1]) > 0 || (Number(version[2]) > 162 || (Number(version[2]) === 162 && Number(version[3]) >= 1))))
}

interface RunnerOptions {
  deviceId: string
  stateDir: string
  link: Pick<ServerLink, "coordinatorCommand" | "coordinatorToolResult">
  signal: AbortSignal
  sandbox: AgentSandbox
  log: Logger
  codexBinary?: string
  claudeBinary?: string
}

/** A claimed personal-assistant turn has no repository, worktree or handoff. */
export async function runNativeCoordinatorJob(job: NativeCoordinatorJob, options: RunnerOptions): Promise<void> {
  const { link, deviceId, signal } = options
  if (!link.coordinatorCommand || !link.coordinatorToolResult) throw new Error("coordinatorTransportUnavailable")
  const submit = link.coordinatorCommand.bind(link)
  const result = link.coordinatorToolResult.bind(link)
  const budget = Math.min(120_000, Date.parse(job.expiresAt) - Date.now())
  if (budget <= 0) throw new Error("coordinatorJobExpired")
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(options.stateDir, "turn-"))
  const cwd = join(dir, "context")
  mkdirSync(cwd, { mode: 0o700 })
  try {
    const tools: CoordinatorTool[] = job.tools.map(spec => {
      const schema = z.fromJSONSchema(spec.inputSchema)
      if (!(schema instanceof z.ZodObject)) throw new Error("coordinatorToolSchemaUnsupported")
      return { name: spec.name, description: spec.description, inputSchema: schema.shape,
        execute: async (input, context) => {
          await submit(deviceId,job.id,{ type: "tool",callId: context.callId,name: spec.name,input },context.signal)
          while (!context.signal.aborted) {
            const answer = await result(deviceId,job.id,context.callId,context.signal)
            if (answer.status === "done") return answer.output
            await delay(500,undefined,{ signal: context.signal })
          }
          context.signal.throwIfAborted()
        },
      }
    })
    const input = { instructions: job.instructions, context: job.context, model: job.model, signal, timeoutMs: budget }
    const reply = job.harness === "claude_code"
      ? await runClaudeCoordinator(input, { cwd, tools, executable: options.claudeBinary })
      : await runCodexCoordinator(input, { cwd, tools, connect: async active => {
        active.throwIfAborted()
        const home = prepareCodexHome(join(dir,"codex-home"),options.log)
        // Never inherit a coding worker's permissive defaults or the user's MCP config.
        writeFileSync(join(home.home,"config.toml"),`approval_policy = "${CODEX_COORDINATOR_APPROVAL_POLICY}"\nsandbox_mode = "read-only"\n`,{ mode: 0o600 })
        const child = await spawnCli(options.sandbox,[options.codexBinary ?? "codex","app-server"],{
          cwd, env: { ...buildChildEnv(process.env), CODEX_HOME: home.home },
          policy: { allowWrite: [dir],
            denyRead: [...credentialDenyRead("codex"),...daemonSecrets(dirname(options.stateDir))],
            allowDomains: HARNESS_DOMAINS.codex },
          pidFile: join(dir,"private","codex.pid"),marker: dir,
        })
        const rpc = jsonlConnection(child.process.stdout,child.process.stdin)
        const cancel = () => { void child.kill().catch(() => undefined) }
        active.addEventListener("abort",cancel,{ once: true })
        if (active.aborted) cancel()
        return { rpc, close: async () => {
          active.removeEventListener("abort",cancel)
          rpc.dispose()
          await child.kill()
        } }
      } })
    signal.throwIfAborted()
    await submit(deviceId,job.id,{ type: "complete",text: reply.text },signal)
  } catch (error) {
    if (!signal.aborted) await submit(deviceId,job.id,{ type: "failed" },signal).catch(() => undefined)
    throw error
  } finally { rmSync(dir,{ recursive: true,force: true }) }
}
