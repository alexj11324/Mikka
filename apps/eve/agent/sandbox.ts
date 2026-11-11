import { defineSandbox } from 'eve/sandbox'
import { JustBashSandbox } from 'eve/sandbox/just-bash'

/** Per-session scratch/attachments; native execution remains on Mikka task machines. */
export const environment = JustBashSandbox.environment({autoInstall:false})
export default defineSandbox(() => environment.open())
