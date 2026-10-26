import 'server-only'
import { pool } from '@/lib/db'
import { NativeCoordinatorStore } from './native-store'
export const nativeCoordinatorStore = new NativeCoordinatorStore(pool)
/** Opt-in rollout: migration + compatible daemon required. Never changes existing defaults. */
export function nativeCoordinatorEnabled() { return process.env.MIKKA_NATIVE_COORDINATOR === '1' }
