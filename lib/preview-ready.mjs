import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

export async function waitForPreviewReady(file, { read = readFile, delay = setTimeout, timeout = 365000 } = {}) {
  if (!file) return true
  const deadline = Date.now() + timeout
  do {
    try {
      const status = await read(file, 'utf8')
      if (status === 'ready') return true
      if (status === 'failed') return false
    } catch (error) {
      if (error?.code !== 'ENOENT') return false
    }
    await delay(100)
  } while (Date.now() < deadline)
  return false
}
