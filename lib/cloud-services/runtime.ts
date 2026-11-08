import 'server-only'
import { pool } from '@/lib/db'
import { isCloudEdition } from '@/lib/edition'
import { CloudClientStore } from './store'
import type { CloudScope } from './types'
import type { RequestBudget } from '../request-budget'

export const cloudClient = new CloudClientStore(pool)
/** Public clients call only requested capabilities; an unconnected install
 * never contacts Mikka Cloud. Code and provider traffic stay on the machine. */
export const cloudRequest = (userId: string, scope: CloudScope, path: string, init?: RequestInit, budget?: RequestBudget) => cloudClient.request(userId, scope, path, init, budget)
export const cloudConnected = () => isCloudEdition() ? Promise.resolve(false) : cloudClient.connected()
