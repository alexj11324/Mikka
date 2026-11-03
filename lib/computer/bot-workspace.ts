import 'server-only'
import { z } from 'zod'
import type { Sandbox } from 'e2b'

export function botWorkspacePath(botId: string) {
  return `/home/user/.mikka/bot-workspaces/${z.uuid().parse(botId)}`
}

/** Initialize only this Bot's private runtime data, retaining existing bytes and Git history. */
export async function initializeBotWorkspace(sandbox: Pick<Sandbox, 'commands'>, botId: string) {
  const path = botWorkspacePath(botId)
  await sandbox.commands.run(`install -d -m 0700 ${path}; if ! test -d ${path}/.git; then git -C ${path} init -q -b main && git -C ${path} -c user.name=Mikka -c user.email=bot@mikka.invalid commit --allow-empty -qm init; fi; git -C ${path} rev-parse --verify main >/dev/null`, { user: 'user', timeoutMs: 20_000 })
  return path
}
