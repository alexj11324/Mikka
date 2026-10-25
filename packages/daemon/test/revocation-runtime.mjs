// Actual daemon and HTTP transport, no MemoryServer, fake CLI, provider or quota source.
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/main.ts'
import { HttpServerLink } from '../src/server-link-http.ts'
const input = createInterface({ input: process.stdin })
let daemon, options, origin
try {
  for await (const line of input) {
    const command = JSON.parse(line)
    if (command.action === 'start') {
      origin = new URL(command.origin)
      if (!['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('isolated origin required')
      options = { dataDir:mkdtempSync(join(tmpdir(),'mikka178-daemon-')), flavor:'prod', credential:command.credential,
        harnesses:[], quotaSource:null, agentSandbox:null, heartbeatMs:200, commandsWaitSeconds:1 }
      daemon = await new Daemon({ ...options, link:new HttpServerLink(origin.toString()) }).start()
    } else if (command.action === 'restart') {
      await daemon.stop()
      daemon = await new Daemon({ ...options, link:new HttpServerLink(origin.toString()) }).start()
    } else if (command.action === 'stop') { await daemon.stop(); break }
    await daemon.syncWithServer()
    const { server, signedIn } = daemon.status()
    process.stdout.write(JSON.stringify({ server, signedIn })+'\n')
  }
} catch { process.stderr.write('Isolated daemon fixture failed; inspect private retained runtime state.\n'); process.exitCode=1 }
finally { await daemon?.stop(); input.close() }
