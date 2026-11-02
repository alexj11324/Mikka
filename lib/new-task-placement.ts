import type { TaskDestination } from './task-destination'
import type { PickerMachine } from './machine-picker'

/** A new task inherits dispatch settings until the person explicitly picks a destination. */
export function defaultTaskMachine<M extends PickerMachine>(machines: readonly M[], order: { location: 'local' | 'cloud'; firstDeviceId: string | null } | undefined): M | undefined {
  if (!order) return undefined
  if (order.location === 'cloud') return machines.find(machine => machine.cloud)
  return machines.find(machine => machine.value === order.firstDeviceId)
}

/** `readyDeviceIds` is the server's planDispatch result, including credential, Agent and broker readiness. */
export function taskMachineUsable(device: { id: string; enabled: boolean; online: boolean }, readyDeviceIds: readonly string[]): boolean {
  return device.enabled && device.online && readyDeviceIds.includes(device.id)
}

export function pickedTaskDestination(picked: string | null): TaskDestination | undefined {
  return picked === null ? undefined : picked === 'cloud' ? { kind: 'cloud' } : { kind: 'device', deviceId: picked }
}
