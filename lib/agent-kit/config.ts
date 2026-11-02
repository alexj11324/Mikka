import { deploymentSwitch } from '@/lib/deployment-switches'
/** Versioned definitions are on by default; operators retain an explicit kill switch. */
export function agentKitEnabled(): boolean { return deploymentSwitch('agentKit') }
