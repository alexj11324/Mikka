import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { basePath as appBasePath } from '../lib/base-path-config.mjs'
import { localServicesChildEnv, localServicesEnabled } from './dev/local-mode.mjs'

export const previewWarmupPaths = ['/', '/api/agent', '/api/agent/sessions', '/api/workspace']

export function isPreviewWarmupEnabled(env = process.env) {
  return env.PREVIEW_WARMUP !== '0'
}

export async function warmPreview(origin, { basePath = appBasePath, fetcher = fetch, log = console.info, timeout = 120000 } = {}) {
  await Promise.all(previewWarmupPaths.map(async path => {
    // HEAD compiles the page's split client chunks and API routes without invoking models or creating data.
    const pathname = path === '/' ? basePath || '/' : `${basePath}${path}`
    const response = await fetcher(new URL(pathname, origin), {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeout),
    })
    const expectedSignInRedirect = path === '/' && response.status === 307
    if (![200, 204, 401, 403].includes(response.status) && !expectedSignInRedirect) throw new Error(`${path}: HTTP ${response.status}`)
    log(`[preview] 已预编译 ${path}`)
  }))
}

/**
 * Local test-account mode (docs/dev-workflow.md § 12) also starts the local
 * substitutes for cloud services and loads their transport into Next only.
 */
export async function localServices(env = process.env) {
  if (!localServicesEnabled(env)) return { env: {}, close: async () => {} }
  const { startLocalServices } = await import('./dev/local-services.mjs')
  const services = await startLocalServices({ env })
  return { env: localServicesChildEnv(env, fileURLToPath(new URL('./dev/local-preload.mjs', import.meta.url))), close: services.close }
}

export async function startPreview() {
  const require = createRequire(import.meta.url)
  const local = await localServices()
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--webpack', ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, ...local.env },
  })
  let output = ''
  let warming = false
  child.stdout.on('data', chunk => {
    const text = chunk.toString()
    process.stdout.write(text)
    output = (output + stripVTControlCharacters(text)).slice(-8192)
    if (!isPreviewWarmupEnabled() || warming || !/Ready in/.test(output)) return
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startPreview()
