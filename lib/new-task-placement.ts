import type { TaskDestination } from './task-destination'
import type { PickerMachine } from './machine-picker'

/** A new task inherits dispatch settings (会先用) until the person explicitly picks a destination. */
export function defaultTaskMachine<M extends PickerMachine>(machines: readonly M[], order: { first: { kind: 'cloud' } | { kind: 'device'; id: string } | null } | undefined): M | undefined {
  if (!order?.first) return undefined
  const first = order.first
  return first.kind === 'cloud' ? machines.find(machine => machine.cloud) : machines.find(machine => machine.value === first.id)
}

/** `readyDeviceIds` is the server's planDispatch result, including credential, Agent and broker readiness. */
export function taskMachineUsable(device: { id: string; enabled: boolean; online: boolean }, readyDeviceIds: readonly string[]): boolean {
  return device.enabled && device.online && readyDeviceIds.includes(device.id)
}

export function pickedTaskDestination(picked: string | null): TaskDestination | undefined {
  if (picked === 'cloudflare') return {kind:'cloud',provider:'cloudflare'}
  return picked === null ? undefined : picked === 'cloud' ? { kind: 'cloud' } : { kind: 'device', deviceId: picked }
}
