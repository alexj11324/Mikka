import { defineSandbox } from 'eve/sandbox'
import { PortableScratchSandbox } from '../../../lib/eve/sandbox'

/** Per-session scratch/attachments; native execution remains on Mikka task machines. */
export const environment = PortableScratchSandbox.environment()
export default defineSandbox(() => environment.open())
