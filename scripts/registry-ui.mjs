import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { registryPreviewSources, sourceHash } from './ui-policy.mjs'

const run = promisify(execFile)
const cli = args => run('pnpm', ['exec', 'shadcn', ...args], { encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })

const policy = JSON.parse(readFileSync('ui-policy.json', 'utf8'))
const config = JSON.parse(readFileSync('components.json', 'utf8'))
const lock = JSON.parse(readFileSync(policy.registryLock, 'utf8'))
const verify = process.argv.includes('--verify')
const refresh = process.argv.includes('--refresh')
const items = process.argv.slice(2).filter(arg => !['--verify', '--refresh'].includes(arg))
if (!items.length && !verify && !refresh) throw new Error('指定明确来源，例如 registry:record @shadcn/button 或 @reui/kanban-board-1；此命令不安装、不覆盖源码。')
for (const envFile of ['.env.development.local', '.env.local']) {
  if (existsSync(envFile)) process.loadEnvFile(envFile)
}
const targets = items.length ? items : Object.keys(lock.items)
if (lock.style !== config.style) throw new Error('Registry lock 与当前 style 不符。先审核 preset 变更，不自动重置来源。')
let failed = false
async function record(item) {
  if (!/^@(shadcn|reui)\/[a-z0-9-]+$/.test(item)) throw new Error(`未审核的 registry 来源：${item}`)
  try {
    const { stdout } = await cli(['view', item])
    const result = JSON.parse(stdout)
    const remote = (Array.isArray(result) ? result : [result]).find(entry => entry.name === item.split('/')[1])
    if (!remote?.files?.length) throw new Error('Registry 未返回源码。')
    const sources = remote.files.filter(file => typeof file.content === 'string' && /\.(?:[jt]sx?|css)$/.test(file.target ?? file.path)).map(file => {
      const target = file.target ?? (file.type === 'registry:ui' ? `${config.aliases.ui.replace(/^@\//, '')}/${path.basename(file.path)}` : file.type === 'registry:hook' ? `${config.aliases.hooks.replace(/^@\//, '')}/${path.basename(file.path)}` : null)
      if (!target || path.isAbsolute(target) || target.split('/').includes('..')) throw new Error('Registry target 无法安全映射。')
      return { ...file, target }
    })
    if (!sources.length) throw new Error('没有可验证的 registry 文件。')
    let selector = sources[0].target
    while (selector !== '.' && !sources.every(file => file.target === selector || file.target.startsWith(`${selector}/`))) selector = path.posix.dirname(selector)
    const selectors = selector === '.' ? sources.map(file => file.target) : [selector]
    const generated = new Map()
    for (const selected of selectors) {
      // An explicit path/prefix disables the CLI's five-file preview limit.
      const { stdout: preview } = await cli(['add', item, '--view', selected])
      for (const [file, content] of registryPreviewSources(preview)) generated.set(file, content)
    }
    const files = sources.map(file => {
      const source = generated.get(file.target)
      if (!source) throw new Error('CLI 未提供转换后的源码；不能退回信任本地文件。')
      return { path: file.target, registryPath: file.path, registrySha256: sourceHash(file.content, file.target), sha256: sourceHash(source, file.target) }
    })
    if (!files.length) throw new Error('没有可验证的 registry 文件。')
    if (verify) {
      const expected = lock.items[item]
      if (!expected || JSON.stringify(files) !== JSON.stringify(expected.files)) {
        console.error(`${item}: 上游来源或 CLI 转换与 lock 不符，需审核更新，不能自行改 hash。`)
        failed = true
      } else console.log(`${item}: registry 原件与 CLI 生成源码已验证`)
    } else {
      lock.items[item] = { files }
      for (const file of files) {
        const matches = existsSync(file.path) && sourceHash(readFileSync(file.path, 'utf8'), file.path) === file.sha256
        console.log(`${file.path}: ${matches ? '与 CLI 生成源码相符' : '缺失或与当前 registry/CLI 输出不同，lint 将报错'}`)
      }
    }
  } catch {
    console.error(`无法验证 ${item}：检查 registry 网络、凭据或 CLI 预览格式；未更改源码，也未放行来源。`)
    failed = true
  }
}
const pending = [...targets]
await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
  while (pending.length) await record(pending.shift())
}))
if (!verify) {
  lock.version = 2
  lock.items = Object.fromEntries(Object.entries(lock.items).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(policy.registryLock, `${JSON.stringify(lock, null, 2)}\n`)
}
process.exitCode = failed ? 1 : 0
