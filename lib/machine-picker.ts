import type { ComputerState } from '@/lib/computer/types'

/** `usable`: the task can run there now. Mikka Cloud needs the person's own E2B key; a device needs to be online. */
export type PickerMachine = { value: string; cloud?: boolean; usable: boolean }

/** The first usable machine in picker order (R-23), else the first machine. */
export function defaultMachine<M extends PickerMachine>(machines: M[]): M | undefined {
  return machines.find(machine => machine.usable) ?? machines[0]
}

/**
 * The machine's state dot: green only while it is actually online. Mikka Cloud is green only
 * while its computer runs, grey asleep or without an E2B key, red when it failed.
 */
export function machineDot(machine: PickerMachine, cloud?: Pick<ComputerState, 'machine'>): 'online' | 'offline' | 'error' {
  if (!machine.cloud) return machine.usable ? 'online' : 'offline'
  if (!machine.usable) return 'offline'
  return cloud?.machine === 'error' ? 'error' : cloud?.machine === 'running' ? 'online' : 'offline'
}
