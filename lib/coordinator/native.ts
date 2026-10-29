import 'server-only'
import { pool } from '@/lib/db'
import { NativeCoordinatorStore } from './native-store'
export const nativeCoordinatorStore = new NativeCoordinatorStore(pool)
/** Deprecated (2026-10-27): kept switched off; bots chat only on Mikka's harness. See docs/architecture/native-coordinator.md. */
export function nativeCoordinatorEnabled() { return process.env.MIKKA_NATIVE_COORDINATOR === '1' }
