import type { ComputerBroker } from './broker.mjs'
export function localComputerMcp(options: {
  broker?: ComputerBroker | null
  runId: string
  permission?: string
  readOnly?: boolean
  proxyPath: string
  nodeBinary: string
}): { command: string; args: string[]; env: Record<string, string> } | undefined
