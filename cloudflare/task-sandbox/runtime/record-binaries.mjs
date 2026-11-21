import { createHash } from 'node:crypto'
import { createReadStream, realpathSync, writeFileSync } from 'node:fs'
const added = {}
for (const [harness, binary] of [['claude_code', 'claude'], ['codex', 'codex']]) {
  const path = realpathSync('/usr/local/bin/' + binary)
  if (!path.startsWith('/opt/mikka/harness/')) throw Error('Task image CLI is outside the pinned install')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  added[harness] = { path, sha256: hash.digest('hex') }
}
writeFileSync('/opt/mikka/worker/.mikka-original-cli.json', JSON.stringify({
  version: 1, kind: 'task', original: { claude_code: null, codex: null }, added,
}), { flag: 'wx', mode: 0o444 })
