import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { basePath as appBasePath } from '../lib/base-path-config.mjs'

export const previewWarmupPaths = ['/api/agent', '/api/agent/sessions', '/api/workspace']

export async function warmPreview(origin, { basePath = appBasePath, fetcher = fetch, log = console.info, timeout = 15000 } = {}) {
  for (const path of previewWarmupPaths) {
    // Unauthorized HEAD requests compile real routes without invoking models or creating data.
    const response = await fetcher(new URL(`${basePath}${path}`, origin), {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeout),
    })
    if (![200, 204, 401, 403].includes(response.status)) throw new Error(`${path}: HTTP ${response.status}`)
    log(`[preview] 已预编译 ${path}`)
  }
}

export function startPreview() {
  const require = createRequire(import.meta.url)
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--webpack', ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env },
  })
  let output = ''
  let warming = false
  child.stdout.on('data', chunk => {
    const text = chunk.toString()
    process.stdout.write(text)
    output = (output + stripVTControlCharacters(text)).slice(-8192)
    if (process.env.PREVIEW_WARMUP !== '1' || warming || !/Ready in/.test(output)) return
    warming = true
    const local = output.match(/Local:\s+http:\/\/[^\s:]+:(\d+)/)
    const port = local?.[1] ?? process.env.PORT ?? '3000'
    void warmPreview(`http://127.0.0.1:${port}`).catch(error => {
      console.error(`[preview] 可选接口预热失败，页面仍可按需加载：${error.message}`)
    })
  })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.on('error', error => {
    console.error(`[preview] 启动失败：${error.message}`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1))
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  return child
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startPreview()
