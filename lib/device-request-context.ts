import { AsyncLocalStorage } from 'node:async_hooks'
import type { DeviceCaller } from './device-link'

/** Scoped to one authenticated route invocation, never entered globally. */
export const deviceRequestCaller = new AsyncLocalStorage<DeviceCaller>()
