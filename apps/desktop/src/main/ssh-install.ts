import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import daemonPackage from '../../../../packages/daemon/package.json' with { type: 'json' }
import { daemonCommands } from '../../../../lib/daemon-commands'
import { CommandFailed, setupError } from '../../../../lib/local-setup-failure'

export const INSTALL_STEPS = ['login', 'check', 'install', 'service', 'connect'] as const
export type InstallStep = typeof INSTALL_STEPS[number]
export type { SshInstallState } from '@mikka/protocol/bridge'
import { LOCAL_RECONNECT, LOCAL_TARGET, type SshInstallState } from '@mikka/protocol/bridge'

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

/** The person's login shell, so a Finder-launched app sees the PATH where node and npm live. */
export function loginShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  const shell = env.SHELL && /^\/[\w/.+-]+$/.test(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
  return { command: shell, args: (script: string) => ['-lc', script] }
}


export function runProcess(command: string, args: string[], input?: string, timeout = 60_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // A login shell/npm can start children. Cancelling only the shell leaves
    // those installers writing into the next attempt's package directory.
    // Own one POSIX process group; never signal an inherited/user service group.
    const grouped = process.platform !== 'win32'
    const child = spawn(command, args, { detached: grouped, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } })
    let output = ''; let error = ''
    let timedOut = false
    let stopped = false
    let closed = false
    const stop = () => {
      if (stopped || closed || !child.pid) return
      stopped = true
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'ESRCH') reject(reason) }
    }
    const abort = () => { stop() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    // Resolve/reject only after close, including timed out commands. Cleanup
    // must not start a new installation while the old command is still alive.
    const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536) })
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-32768) })
    child.on('error', reason => { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(reason) })
    child.on('close', code => {
      closed = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) { reject(new Error('cancelled')); return }
      if (timedOut) { reject(new Error('SSH operation timed out')); return }
      if (code === 0) resolve(output.trim())
      else reject(new CommandFailed(code, error))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

class LocalAccountUnconfirmed extends Error {}

export class SshInstaller {
  private controller = new AbortController()
  private beginning = false
  private pending: Promise<unknown> = Promise.resolve()
  private current?: SshInstallState
  private keyLine?: string
  private options: string[] = []
  private destination = ''
  /** Set by beginLocal / restartLocal: the steps run on this computer, not over SSH. */
  private local = false
  private localOwnerId?: string
  /** PATH entries this install found it needs (shell-quoted): a new enough Node, the user npm prefix. */
  private paths: string[] = []
  constructor(
    private appUrl: string,
    private mintToken: () => Promise<string>,
    private onState: (state: SshInstallState) => void = () => {},
    private execute = runProcess,
    private home = homedir(),
    private installCommand?: string,
    private configFile?: string,
    /** The desktop's flavor: a dev app talks to the dev daemon's data dir. */
    private flavor: 'prod' | 'dev' = 'prod',
    private shell = loginShell(),
    private verifyLocalDevice: (deviceId: string, ownerId?: string) => Promise<boolean> = async () => false,
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
    return this.launch(() => { this.local = false; return this.start(target) })
  }
  /**
   * 添加这台电脑: the same install, run on this computer through the login
   * shell, registered as a laptop. No SSH, no host key.
   */
  async beginLocal(ownerId?: string) {
    return this.launch(async () => {
      this.local = true
      this.localOwnerId = ownerId
      this.current = { id: randomUUID(), target: LOCAL_TARGET, step: 'check', status: 'running' }
      this.report({})
      this.pending = this.install('laptop')
      return this.state()
    })
  }
  /**
   * The automatic setup when its daemon does not answer: restart the service,
   * and only if that fails install and sign in, so an existing device is not
   * registered again. Reported as 添加这台电脑.
   */
  async repairLocal(ownerId?: string) {
    return this.launch(async () => {
      this.local = true
      this.localOwnerId = ownerId
      this.current = { id: randomUUID(), target: LOCAL_TARGET, step: 'service', status: 'running' }
      this.report({})
      this.pending = this.repair()
      return this.state()
    })
  }
  /** 重新连接 for this computer: restart its daemon service and wait until it is online. */
  async restartLocal(ownerId?: string) {
    return this.launch(async () => {
      this.local = true
      this.localOwnerId = ownerId
      this.current = { id: randomUUID(), target: LOCAL_RECONNECT, step: 'service', status: 'running' }
      this.report({})
      this.pending = this.restart()
      return this.state()
    })
  }
  private async launch(run: () => Promise<SshInstallState | null>) {
    if (this.beginning || this.current?.status === 'running' || this.current?.status === 'fingerprint') throw new Error('Installation already active')
    this.beginning = true
    try {
      await this.pending
      this.controller = new AbortController()
      const starting = run()
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
    this.report({ status: 'failed', reason: 'cancelled', detail: 'cancelled', retryable: true })
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
    if (this.controller.signal.aborted || !this.current) return
    const { failure } = setupError(error)
    this.report({ status: 'failed', retryable: true, reason: failure.summary || 'SSH installation failed', detail: failure.detail, values: failure.values, ...(failure.log ? { log: failure.log } : {}) })
  }
  private remote(command: string, input?: string, timeout?: number) {
    // Directories found during this install (a newer Node, the user npm prefix) come first in PATH.
    const script = this.paths.length ? `PATH=${this.paths.join(':')}:"$PATH"; ${command}` : command
    if (this.local) return this.run(this.shell.command, this.shell.args(script), input, timeout)
    return this.run('ssh', [...this.options, this.destination, script], input, timeout)
  }
  /**
   * The login shell's Node is missing or too old (a non-interactive login shell
   * skips .zshrc, so nvm's Node is absent and Homebrew's older one comes
   * first). Use the newest installed Node that is new enough, if there is one.
   */
  private async findNode(minimum: number) {
    // /bin/sh: an unmatched glob stays literal there, while zsh would abort the whole line.
    const found = await this.remote(`/bin/sh -c 'for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME"/.volta/bin /opt/homebrew/opt/node@*/bin /opt/homebrew/opt/node/bin /usr/local/opt/node@*/bin /usr/local/opt/node/bin /opt/homebrew/bin /usr/local/bin; do [ -x "$d/node" ] && echo "$("$d/node" --version 2>/dev/null) $d"; done; true'`).catch(() => '')
    const best = found.split('\n').map(line => /^v(\d+)\.\S* (\/\S.*)$/.exec(line.trim())).filter(match => match && +match[1] >= minimum)
      .sort((a, b) => +b![1] - +a![1])[0]
    return best ? best[2] : null
  }
  /**
   * npm cannot write where it installs: a root-owned global prefix (the
   * nodejs.org installer, apt) or a cache left root-owned by an earlier
   * `sudo npm`. Retry with Mikka's own cache, then also its own prefix,
   * whose bin then comes first in PATH for the later steps.
   */
  private async npmInstall(command: string) {
    const attempts = [command, `${command} --cache "$HOME/.mikka/npm-cache"`, `${command} --cache "$HOME/.mikka/npm-cache" --prefix "$HOME/.mikka/npm"`]
    for (let index = 0; ; index++) {
      try {
        await this.remote(attempts[index], undefined, 300_000)
        if (index === 2) this.paths.push('"$HOME/.mikka/npm/bin"')
        return
      } catch (error) {
        if (this.installCommand || this.controller.signal.aborted || index === 2) throw error
        const failure = setupError(error).failure
        if (failure.detail !== 'npm_permission') throw error
        // Only the cache was refused: a private cache is enough. Otherwise skip to the private prefix.
        if (index === 0 && !/_cacache/.test(failure.log)) index = 1
      }
    }
  }
  /** `--dev` for a dev desktop's own daemon on this computer; a remote host runs the production one. */
  private flags() {
    return this.local && this.flavor === 'dev' ? ' --dev' : ''
  }
  private async install(deviceType: 'server' | 'laptop' = 'server') {
    try {
      if (!this.local) await this.remote('true')
      this.report({ step: 'check' })
      const engine = daemonPackage.engines.node
      const minimum = /^>=(\d+)$/.exec(engine)?.[1]
      if (!minimum) throw new Error('Unsupported daemon Node engine range')
      // The failure names the Node the login shell found (Homebrew's can come first in PATH).
      const check = `case "$(uname -s)" in Linux|Darwin) ;; *) echo 'Linux or macOS required' >&2; exit 1;; esac; command -v node >/dev/null || { echo 'Node.js ${engine} required (node not found)' >&2; exit 1; }; node -e 'if (+process.versions.node.split(".")[0] < ${minimum}) { console.error("Node.js ${engine} required (found v" + process.versions.node + " at " + process.execPath + ")"); process.exit(1) }'`
      this.paths = []
      try { await this.remote(check) }
      catch (error) {
        const detail = setupError(error).failure.detail
        if (detail !== 'node_too_old' && detail !== 'node_missing') throw error
        const node = await this.findNode(+minimum)
        if (!node) throw error
        this.paths.push(quote(node))
        await this.remote(check)
      }
      this.report({ step: 'install' })
      const url = new URL(this.appUrl)
      const commands = daemonCommands({ origin: url.origin, basePath: url.pathname.replace(/\/$/, ''), packageName: '@aspectlylabs/mikka' })
      await this.npmInstall(this.installCommand ?? commands.install)
      this.report({ step: 'service' })
      await this.remote(`mikka daemon service install --server ${quote(this.appUrl)} --device-type ${deviceType}${this.flags()}`)
      await this.connect()
    } catch (error) { this.fail(error) }
  }
  private async connect() {
    this.report({ step: 'connect' })
    const token = await this.mintToken()
    this.controller.signal.throwIfAborted()
    // Token travels only on stdin (encrypted over SSH), never argv, logs or shell text.
    await this.remote(`mikka daemon login --server ${quote(this.appUrl)} --registration-token-stdin${this.flags()}`, `${token}\n`)
    await this.waitOnline()
  }
  private async repair() {
    try {
      await this.remote(`mikka daemon service install --server ${quote(this.appUrl)} --device-type laptop${this.flags()}`)
      if (await this.waitOnline(true) === 'online') return
    } catch (error) {
      if (this.controller.signal.aborted) return
      if (error instanceof LocalAccountUnconfirmed) { this.fail(error); return }
      this.report({ step: 'check' })
      await this.install('laptop')
      return
    }
    // The installed daemon answered and explicitly has no credential. Sign it
    // in through the same enrollment flow; reinstalling would stop a working
    // service and needlessly bootstrap it a second time.
    try { await this.connect() } catch (error) { this.fail(error) }
  }
  /** Rewrites and restarts the service (`service install` restarts it), then waits until it is online. */
  private async restart() {
    try {
      await this.remote(`mikka daemon service install --server ${quote(this.appUrl)} --device-type laptop${this.flags()}`)
      this.report({ step: 'connect' })
      await this.waitOnline()
    } catch (error) { this.fail(error) }
  }
  private async waitOnline(allowUnregistered = false): Promise<'online' | 'unregistered'> {
    for (let attempt = 0; attempt < 30; attempt++) {
      this.controller.signal.throwIfAborted()
      const status = await this.remote(`mikka daemon status${this.flags()}`).catch(() => '')
      let remote: { server?: string; deviceId?: string; signedIn?: boolean }
      try { const parsed = JSON.parse(status); remote = parsed && typeof parsed === 'object' ? parsed : {} } catch { remote = {} }
      if (allowUnregistered && remote.server === 'unregistered' && remote.signedIn === false) return 'unregistered'
      if (remote.server === 'online') {
        if (this.local) {
          if (typeof remote.deviceId !== 'string' || !remote.deviceId) throw new Error('Device does not belong to the signed-in account')
          let owned: boolean
          try { owned = await this.verifyLocalDevice(remote.deviceId, this.localOwnerId) }
          catch { throw new LocalAccountUnconfirmed('Device account could not be confirmed') }
          if (!owned) throw new Error('Device does not belong to the signed-in account')
        }
        this.controller.signal.throwIfAborted()
        this.report({ status: 'online', ...(typeof remote.deviceId === 'string' ? { deviceId: remote.deviceId } : {}) })
        return 'online'
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Device did not come online within 30 seconds')
  }
}
