import 'server-only'
import { pool } from '@/lib/db'
import { NativeCoordinatorStore } from './native-store'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
export const nativeCoordinatorStore = new NativeCoordinatorStore(pool, notifyDeviceWork)
// Historical rows and tool-scope authorization only; no selectable runtime.
