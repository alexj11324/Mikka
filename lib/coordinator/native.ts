import 'server-only'
import { pool } from '@/lib/db'
import { NativeCoordinatorStore } from './native-store'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
export const nativeCoordinatorStore = new NativeCoordinatorStore(pool, notifyDeviceWork)
/** Deprecated (2026-10-27): always off, with no switch; bots chat only on Mikka's harness. See docs/architecture/native-coordinator.md. */
export function nativeCoordinatorEnabled() { return false }
