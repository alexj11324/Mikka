import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { preflight } = await import(pathToFileURL(join(process.env.RUNNER_TEMP,'diagnostic-prepare-guard.mjs')).href)
await preflight()
