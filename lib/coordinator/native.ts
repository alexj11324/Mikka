import 'server-only'
import { pool } from '@/lib/db'
import { NativeCoordinatorStore } from './native-store'
export const nativeCoordinatorStore = new NativeCoordinatorStore(pool)
// Historical rows and tool-scope authorization only; no selectable runtime.
