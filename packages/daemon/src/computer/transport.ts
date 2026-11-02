import type { McpServerSpec } from '../agents/run-context'

/** Only a trusted host-provided loopback port may serve a run's computer broker. */
export function computerDomain(spec?: McpServerSpec) {
  const target = spec?.args[1]
  if (!target?.startsWith('tcp://')) return undefined
  const url = new URL(target)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname || url.search || url.hash) throw new Error('Invalid local computer endpoint')
  return `${url.hostname}:${url.port}`
}
