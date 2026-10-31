import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import daemonPackage from '../../../../packages/daemon/package.json' with { type: 'json' }
import { daemonCommands } from '../../../../lib/daemon-commands'

export const INSTALL_STEPS = ['login', 'check', 'install', 'service', 'connect'] as const
export type InstallStep = typeof INSTALL_STEPS[number]
export type { SshInstallState } from '@mikka/protocol/bridge'
import type { SshInstallState } from '@mikka/protocol/bridge'

export function parseTarget(raw: string) {
  const match = /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?([A-Za-z0-9_][A-Za-z0-9_.-]*)(?::([0-9]{1,5}))?$/.exec(raw.trim())
  if (!match || (match[3] && (+match[3] < 1 || +match[3] > 65535))) throw new Error('Invalid SSH host')
  return { destination: `${match[1] ? `${match[1]}@` : ''}${match[2]}`, host: match[2], port: match[3] }
}
export function parseHosts(config: string): string[] {
  return [...new Set(config.split(/\r?\n/).flatMap(line => {
    const match = /^\s*Host\s+(.+?)(?:\s+#.*)?$/i.exec(line)
    return match ? match[1].split(/\s+/).filter(host => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host)) : []
  }))]
}
export function parseHostDetails(config: string) {
  const fields = Object.fromEntries(config.split(/\r?\n/).map(line => { const [key, ...value] = line.trim().split(/\s+/); return [key, value.join(' ')] }))
  return { user: fields.user ?? '', hostName: fields.hostname ?? '', port: Number(fields.port ?? 22) }
}
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

export function runProcess(command: string, args: string[], input?: string, timeout = 60_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } })
    let output = ''; let error = ''
    const abort = () => { child.kill('SIGKILL') }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SSH operation timed out')) }, timeout)
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536) })
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4096) })
    child.on('error', reason => { clearTimeout(timer); reject(reason) })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(new Error('cancelled')); return }
      if (code === 0) resolve(output.trim())
      else reject(new Error(error.trim() || `Remote command failed (${code})`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export class SshInstaller {
  private controller = new AbortController()
  private beginning = false
  private pending: Promise<unknown> = Promise.resolve()
  private current?: SshInstallState
  private keyLine?: string
  private options: string[] = []
  private destination = ''
  constructor(
    private appUrl: string,
    private mintToken: () => Promise<string>,
    private onState: (state: SshInstallState) => void = () => {},
    private execute = runProcess,
    private home = homedir(),
    private installCommand?: string,
    private configFile?: string,
  ) {}
  private report(patch: Partial<SshInstallState>) {
    this.current = { ...this.current!, ...patch }
    this.onState(this.state()!)
  }
  state() { return this.current ? { ...this.current } : null }
  async hosts() {
    const aliases = parseHosts(await readFile(this.configFile ?? join(this.home, '.ssh/config'), 'utf8').catch(() => ''))
    return Promise.all(aliases.map(async alias => {
      const config = await this.execute('ssh', ['-G', ...(this.configFile ? ['-F', this.configFile] : []), alias])
      return { alias, ...parseHostDetails(config) }
    }))
  }
  async begin(target: string) {
    if (this.beginning || this.current?.status === 'running' || this.current?.status === 'fingerprint') throw new Error('Installation already active')
    this.beginning = true
    try {
      await this.pending
      this.controller = new AbortController()
      const starting = this.start(target)
      this.pending = starting
      await starting
      return this.state()
    } finally { this.beginning = false }
  }
  private async start(target: string) {
    this.current = { id: randomUUID(), target, step: 'login', status: 'running' }
    this.keyLine = undefined
    this.report({})
    try {
      const parsed = parseTarget(target)
      this.destination = parsed.destination
      const port = [...(this.configFile ? ['-F', this.configFile] : []), ...(parsed.port ? ['-p', parsed.port] : [])]
      const config = await this.run('ssh', ['-G', ...port, this.destination])
      const value = (key: string) => config.split('\n').find(line => line.startsWith(`${key} `))?.slice(key.length + 1)
      const host = value('hostname') ?? parsed.host
      const actualPort = value('port') ?? '22'
      // ssh -G resolves aliases, users, key paths and ports through OpenSSH.
      this.options = ['-oUserKnownHostsFile=' + join(this.home, '.ssh/known_hosts'), '-oBatchMode=yes', '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=15', ...port]
      const knownName = actualPort === '22' ? host : `[${host}]:${actualPort}`
      const known = await this.run('ssh-keygen', ['-F', knownName, '-f', join(this.home, '.ssh/known_hosts')]).catch(() => '')
      if (!known) {
        const scanned = await this.run('ssh-keyscan', ['-T', '10', '-p', actualPort, '-t', 'ed25519', host])
        const key = scanned.split('\n').find(line => !line.startsWith('#') && line.split(' ').length === 3)
        if (!key) throw new Error('No supported host key returned')
        this.keyLine = key
        const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(key.split(' ')[2], 'base64')).digest('base64').replace(/=+$/, '')}`
        this.report({ status: 'fingerprint', fingerprint, keyType: key.split(' ')[1].replace(/^ssh-/, '').toUpperCase() })
      } else {
        this.pending = this.install()
      }
    } catch (error) { this.fail(error) }
    return this.state()
  }
  async accept(id: string) {
    if (this.current?.id !== id || this.current.status !== 'fingerprint' || !this.keyLine) throw new Error('No pending fingerprint')
    const signal = this.controller.signal
    const keyLine = this.keyLine
    this.report({ status: 'running' })
    const confirming = (async () => {
      try {
        await mkdir(join(this.home, '.ssh'), { recursive: true, mode: 0o700 })
        signal.throwIfAborted()
        await appendFile(join(this.home, '.ssh/known_hosts'), `\n${keyLine}\n`, { mode: 0o600 })
        signal.throwIfAborted()
        this.pending = this.install()
      } catch (error) { this.fail(error) }
    })()
    this.pending = confirming
    await confirming
    return this.state()
  }
  async cancel(id: string) {
    if (this.current?.id !== id || !['running', 'fingerprint'].includes(this.current.status)) throw new Error('No active installation')
    this.controller.abort()
    this.report({ status: 'failed', reason: 'cancelled', retryable: true })
    await this.pending
    return this.state()
  }
  private async run(command: string, args: string[], input?: string, timeout?: number) {
    const signal = this.controller.signal
    signal.throwIfAborted()
    const output = await this.execute(command, args, input, timeout, signal)
    signal.throwIfAborted()
    return output
  }
  private fail(error: unknown) {
    if (!this.controller.signal.aborted && this.current) this.report({ status: 'failed', retryable: true, reason: error instanceof Error ? error.message : 'SSH installation failed' })
  }
  private remote(command: string, input?: string, timeout?: number) {
    return this.run('ssh', [...this.options, this.destination, command], input, timeout)
  }
  private async install() {
    try {
      await this.remote('true')
      this.report({ step: 'check' })
      const engine = daemonPackage.engines.node
      const minimum = /^>=(\d+)$/.exec(engine)?.[1]
      if (!minimum) throw new Error('Unsupported daemon Node engine range')
      await this.remote(`case "$(uname -s)" in Linux|Darwin) ;; *) echo 'Linux or macOS required' >&2; exit 1;; esac; command -v node >/dev/null || { echo 'Node.js ${engine} required' >&2; exit 1; }; node -e 'if (+process.versions.node.split(".")[0] < ${minimum}) { console.error("Node.js ${engine} required"); process.exit(1) }'`)
      this.report({ step: 'install' })
      const url = new URL(this.appUrl)
      const commands = daemonCommands({ origin: url.origin, basePath: url.pathname.replace(/\/$/, ''), packageName: '@aspectlylabs/mikka' })
      await this.remote(this.installCommand ?? commands.install, undefined, 300_000)
      this.report({ step: 'service' })
      await this.remote(`mikka daemon service install --server ${quote(this.appUrl)} --device-type server`)
      this.report({ step: 'connect' })
      const token = await this.mintToken()
      this.controller.signal.throwIfAborted()
      // Token travels only on encrypted stdin, never argv, logs or shell text.
      await this.remote(`mikka daemon login --server ${quote(this.appUrl)} --registration-token-stdin`, `${token}\n`)
      for (let attempt = 0; attempt < 30; attempt++) {
        this.controller.signal.throwIfAborted()
        const status = await this.remote('mikka daemon status').catch(() => '')
        try {
          const remote = JSON.parse(status) as { server?: string; deviceId?: string }
          if (remote.server === 'online') {
            this.report({ status: 'online', ...(typeof remote.deviceId === 'string' ? { deviceId: remote.deviceId } : {}) })
            return
          }
        } catch { /* service starting */ }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error('Device did not come online within 30 seconds')
    } catch (error) { this.fail(error) }
  }
}
