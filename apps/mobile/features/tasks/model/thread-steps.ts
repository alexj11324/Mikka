/**
 * A thread's folded tool calls (「已运行 2 条命令 · 调用了 1 个工具」), as the server sends them in the mobile thread read
 * (lib/issue-run-conversation.ts `ThreadStep`): a name, the one input that says what it did, and whether it failed.
 * `output` and `ms` are not sent yet; when they are, a step shows its output and how long it took.
 */
export type ThreadStep = { id: string; name: string; detail: string | null; failed: boolean; output?: string | null; ms?: number | null }

/** Claude Code's `Bash`, Codex's `bash` and Cursor's `execute` run a command; everything else is a tool. */
const COMMANDS = new Set(['bash', 'shell', 'execute'])
export const isCommand = (step: Pick<ThreadStep, 'name'>) => COMMANDS.has(step.name.toLowerCase())

/** The row's words, as Codex says them: 「已运行 2 条命令 · 调用了 1 个工具」; without the steps, 「3 步」. */
export function stepsLabel(steps: readonly Pick<ThreadStep, 'name'>[] | undefined, count: number) {
  if (!steps?.length) return `${count} 步`
  const commands = steps.filter(isCommand).length
  const tools = steps.length - commands
  return [commands ? `已运行 ${commands} 条命令` : null, tools ? `调用了 ${tools} 个工具` : null].filter(Boolean).join(' · ')
}

/** A command as it was typed: Codex wraps it in `/bin/bash -lc "…"`, which says nothing. */
export function commandText(detail: string | null) {
  if (!detail) return ''
  const text = detail.trim()
  // The server cuts a long detail at 200 characters with 「…」, so the closing quote may be gone.
  const open = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(["'])/.exec(text)
  if (!open) return text
  const quote = open[1]!
  const rest = text.slice(open[0].length)
  return (rest.endsWith(quote) ? rest.slice(0, -1) : rest.endsWith(`${quote}…`) ? `${rest.slice(0, -2)}…` : rest).trim()
}

/** A tool's name without its MCP server: `mcp__mikka__record_decision` reads `record_decision`. */
export const toolName = (name: string) => name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name

/** What a step's line shows: the command itself, or the tool and the input that says what it did (a path's last parts). */
export function stepLine(step: Pick<ThreadStep, 'name' | 'detail'>) {
  if (isCommand(step)) return { title: commandText(step.detail) || step.name, detail: null, code: true }
  const detail = step.detail && /^\/\S+$/.test(step.detail) ? step.detail.split('/').slice(-2).join('/') : step.detail
  return { title: toolName(step.name), detail: detail || null, code: false }
}

/** 「1.2 秒」, 「850 毫秒」, 「2 分 5 秒」. */
export function stepDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}
