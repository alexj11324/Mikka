// The anonymous catalogue gate must not import the daemon, Coordinator or SDKs.
// Keep the exact same CLI selection, exchange and cleanup as the preloaded worker.
import { probeHostedModels } from '../src/cloud-model-probe'

void probeHostedModels().then(reports => {
  process.stdout.write(JSON.stringify(reports) + '\n')
}).catch(() => {
  process.stderr.write('Cloud model probe unavailable\n')
  process.exitCode = 1
})
