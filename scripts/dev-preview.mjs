import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { basePath as appBasePath } from '../lib/base-path-config.mjs'

export const previewWarmupPaths = ['/api/agent', '/api/agent/sessions', '/api/workspace']

export async function warmPreview(origin, { basePath = appBasePath, fetcher = fetch, log = console.info } = {}) {
  await Promise.all(previewWarmupPaths.map(async path => {
    // Unauthorized HEAD requests compile real routes without invoking models or creating data.
    const response = await fetcher(new URL(`${basePath}${path}`, origin), {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(120000),
    })
    if (![200, 204, 401, 403].includes(response.status)) throw new Error(`${path}: HTTP ${response.status}`)
    log(`[preview] 已预编译 ${path}`)
  }))
}

export function startPreview() {
  const require = createRequire(import.meta.url)
  const readyFile = join(tmpdir(), `orvilo-preview-${randomUUID()}.ready`)
  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--webpack', ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, PREVIEW_READY_FILE: readyFile },
  })
  let output = ''
  let warming = false
  child.stdout.on('data', chunk => {
    const text = chunk.toString()
    process.stdout.write(text.replace(/Ready in/g, '服务启动，正在预编译；耗时'))
    output = (output + stripVTControlCharacters(text)).slice(-8192)
    if (warming || !/Ready in/.test(stripVTControlCharacters(text))) return
    warming = true
    const local = output.match(/Local:\s+http:\/\/[^\s:]+:(\d+)/)
    const port = local?.[1] ?? process.env.PORT ?? '3000'
    void warmPreview(`http://127.0.0.1:${port}`).then(async () => {
      await writeFile(readyFile, 'ready', { mode: 0o600 })
      console.info('[preview] 常用接口后台编译完成。')
    }).catch(async error => {
      console.error(`[preview] 后台预编译失败，页面仍可加载；相关模块将按需重试：${error.message}`)
      await writeFile(readyFile, 'failed', { mode: 0o600 }).catch(() => {})
    }).finally(() => { warming = false })
  })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.on('error', error => {
    console.error(`[preview] 启动失败：${error.message}`)
    process.exitCode = 1
  })
  child.on('exit', code => {
    void unlink(readyFile).catch(() => {}).finally(() => process.exit(code ?? 1))
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  return child
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startPreview()
