// Actual credential browser client against the isolated local gateway fixture.
import { Cdp } from '../../lib/credentials/browser.ts'

const [endpoint, target, origin, loaderId, backendNodeId] = process.argv.slice(2)
const cdp = await Cdp.connect(endpoint)
try {
  await cdp.attach(target)
  await cdp.insertAtObservedInput(origin, loaderId, Number(backendNodeId), 'username', 'synthetic-user')
  process.stdout.write('PASS: actual broker client inserted into its observed node')
} finally { cdp.close() }
