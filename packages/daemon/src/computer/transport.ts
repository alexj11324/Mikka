import type { McpServerSpec } from '../agents/run-context'
import type { SandboxPolicy } from '../agents/sandbox'

/** Only a trusted host-provided loopback port may enter this run's allow-list. */
export function computerDomain(spec?: McpServerSpec) {
  const target = spec?.args[1]
  if (!target?.startsWith('tcp://')) return undefined
  const url = new URL(target)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname || url.search || url.hash) throw new Error('Invalid local computer endpoint')
  return `${url.hostname}:${url.port}`
}
export function sandboxComputerSpec(spec: McpServerSpec | undefined, kind: string) {
  return spec && computerDomain(spec) && kind === 'sandbox-runtime'
    ? { ...spec, env: { ...spec.env, MIKKA_COMPUTER_SANDBOX_PROXY: '1' } } : spec
}
export function computerSandboxPolicy(policy: SandboxPolicy, spec?: McpServerSpec): SandboxPolicy {
  const domain = computerDomain(spec)
  return domain ? { ...policy, allowDomains: [...policy.allowDomains, domain] } : policy
}
