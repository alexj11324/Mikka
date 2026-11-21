import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** A disposable task VM receives one device handoff over native process stdin.
 * The standard cloud-worker bootstrap does the authoritative validation and
 * consumes these two private files. Nothing from a previous task is accepted. */
export async function receiveTaskHandoff(root: string, input: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    size += chunk.byteLength
    if (size > 8192) throw Error('Cloud task handoff too large')
    chunks.push(Buffer.from(chunk))
  }
  const { runId, bootstrap } = z.object({ runId: z.uuid(), bootstrap: z.string().min(2).max(4096) }).strict()
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw Error('Cloud task handoff directory unavailable')
  const privateFile = { mode: 0o600, flag: 'wx' } as const
  writeFileSync(join(root, 'initial-run.json'), JSON.stringify({
    version: 1, runId, bootstrapSha256: createHash('sha256').update(bootstrap).digest('hex'),
  }), privateFile)
  writeFileSync(join(root, 'bootstrap.json'), bootstrap, privateFile)
}
