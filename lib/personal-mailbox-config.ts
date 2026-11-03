import { deploymentSwitch } from '@/lib/deployment-switches'
/** Enabled in production; the explicit kill switch creates no user/snapshot grant. */
export function personalMailboxEnabled(): boolean { return deploymentSwitch('personalMailbox') }
