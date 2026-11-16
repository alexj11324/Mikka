import { cloudShortId, machineDot, machineStateWord, systemLabel, type ThreadMachine } from '../../../lib/thread-machine'
import { mobileLocale, mobileMessages } from './messages'
import { agoWhen } from './clock'

export type { ThreadMachine, ThreadMachineKind, ThreadMachineState } from '../../../lib/thread-machine'

const words = mobileMessages.ThreadRunPlace

/** The SF Symbol for each machine kind. */
export const MACHINE_SYMBOL = { cloud: 'cloud', laptop: 'laptopcomputer', server: 'server.rack' } as const

const time = (value: string) => new Date(value).toLocaleString(mobileLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
export function machineLines(machine: ThreadMachine, now = Date.now()) {
  const name = machine.kind === 'cloud' && machine.cloud
    ? words.cloudName.replace('{id}', cloudShortId(machine.cloud.sandboxId))
    : machine.name || words.kinds[machine.kind]
  const system = systemLabel(machine.platform, machine.arch)
  const rows: [string, string][] = []
  if (machine.cloud) {
    rows.push([words.id, machine.cloud.sandboxId])
    if (machine.cloud.template) rows.push([words.template, machine.cloud.template])
    rows.push([words.created, time(machine.cloud.createdAt)])
    if (machine.cloud.endedAt) rows.push([words.stopped, time(machine.cloud.endedAt)])
  }
  if (system) rows.push([words.system, system])
  if (machine.hostname) rows.push([words.host, machine.hostname])
  if (machine.state === 'offline' && machine.lastSeenAt) rows.push([words.lastSeen, agoWhen(machine.lastSeenAt, now)])
  const dot = machineDot(machine.state)
  return { name, state: words.states[machineStateWord(machine)], live: dot === 'running', failed: dot === 'failed', rows }
}
