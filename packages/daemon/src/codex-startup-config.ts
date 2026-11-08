import {constants} from 'node:fs'
import {createHash} from 'node:crypto'
import {lstat, open, readdir, realpath} from 'node:fs/promises'
import {dirname, isAbsolute, join, parse, resolve} from 'node:path'

// Codex 0.166 keeps AuthManager, thread store, model/skill managers and OTEL
// process-scoped. A final-cwd thread reload cannot repair those differences.
const AUTH_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CHATGPT_ACCESS_TOKEN']
export type CodexSystemSkills = Readonly<{ home: string; digest: string }>
async function absent(path: string) {
  try { await lstat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}

/** Only called after this process initialized from an absent skills directory.
 * The native CLI installs its embedded skills under skills/.system. Snapshot
 * those public files without following links; never admit added user skills. */
export async function captureCodexSystemSkills(env: Record<string, string | undefined>): Promise<CodexSystemSkills | undefined> {
  if (!env.HOME) throw Error('Codex home unavailable')
  const root = join(env.HOME, '.codex', 'skills')
  if (await absent(root)) return
  const entries = await readdir(root)
  if (entries.length !== 1 || entries[0] !== '.system') throw Error('Codex user skills appeared')
  const hash = createHash('sha256')
  let nodes = 0, bytes = 0, marker = false
  const visit = async (path: string, relative: string): Promise<void> => {
    if (++nodes > 512 || relative.length > 4096) throw Error('Codex skills snapshot limit')
    const meta = await lstat(path)
    if (meta.isSymbolicLink() || meta.uid !== process.getuid?.() || (meta.mode & 0o022) !== 0) throw Error('Codex skills owner unavailable')
    hash.update(JSON.stringify([relative, meta.mode & 0o777, meta.size]) + '\n')
    if (meta.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? relative + '/' + name : name)
      return
    }
    if (!meta.isFile() || meta.nlink !== 1 || (bytes += meta.size) > 4 * 1024 * 1024) throw Error('Codex skills file unavailable')
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const actual = await fd.stat()
      if (actual.ino !== meta.ino || actual.dev !== meta.dev || actual.size !== meta.size) throw Error('Codex skills changed')
      const buffer = Buffer.alloc(meta.size + 1)
      let read = 0
      while (read < buffer.length) {
        const part = await fd.read(buffer, read, buffer.length - read, null)
        if (!part.bytesRead) break
        read += part.bytesRead
      }
      const after = await fd.stat()
      if (read !== meta.size || after.size !== meta.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) throw Error('Codex skills changed')
      hash.update(buffer.subarray(0, read))
      if (relative === '.system/.codex-system-skills.marker' && read > 0 && read <= 128) marker = true
    } finally { await fd.close() }
  }
  await visit(root, '')
  if (!marker) throw Error('Codex system skills marker unavailable')
  return { home: env.HOME, digest: hash.digest('hex') }
}

export async function codexAnonymousHomeEligible(env: Record<string, string | undefined>, systemSkills?: CodexSystemSkills): Promise<boolean> {
  if (!env.HOME || !isAbsolute(env.HOME) || (env.CODEX_HOME && env.CODEX_HOME !== join(env.HOME, '.codex')) ||
    AUTH_ENV.some(key => Boolean(env[key])) || env.CODEX_CONFIG_PATH || env.CODEX_PROFILE) return false
  try {
    if (await realpath(env.HOME) !== resolve(env.HOME)) return false
    const home = join(env.HOME, '.codex')
    if (!await absent(home)) {
      const stat = await lstat(home)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return false
    }
  } catch { return false }
  // Absence is intentional: custom settings remain supported by the cold path.
  // Never parse a credential or silently ignore an unreadable config.
  for (const path of [
    '/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    ...['config.toml', 'managed_config.toml', 'requirements.toml', 'auth.json', 'plugins', 'hooks.json', 'rules']
      .map(name => join(env.HOME!, '.codex', name)),
    join(env.HOME, '.agents', 'skills'),
  ]) if (!await absent(path)) return false
  if (!systemSkills) return absent(join(env.HOME, '.codex', 'skills'))
  if (systemSkills.home !== env.HOME) return false
  try { return (await captureCodexSystemSkills(env))?.digest === systemSkills.digest } catch { return false }
}


type GitMetadata = { path: string; text: string; signature: string }
async function ownedGitDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 || await realpath(path) !== resolve(path)) throw Error('Codex Git directory unavailable')
}

/** No Git execution, config includes or metadata outside the host-proven clone. */
async function readGitMetadata(path: string): Promise<GitMetadata> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 || stat.size < 1 || stat.size > 4096) throw Error('Codex Git metadata unavailable')
    const bytes = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < bytes.length) {
      const part = await fd.read(bytes, count, bytes.length - count, null)
      if (!part.bytesRead) break
      count += part.bytesRead
    }
    const signature = (s: typeof stat) => JSON.stringify([s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs])
    if (count !== stat.size || signature(stat) !== signature(await fd.stat())) throw Error('Codex Git metadata changed')
    return { path, text: bytes.subarray(0, count).toString('utf8'), signature: signature(stat) }
  } finally { await fd.close() }
}

async function registeredWorktree(cwd: string, repositoryRoot: string) {
  if (!isAbsolute(repositoryRoot) || await realpath(repositoryRoot) !== resolve(repositoryRoot)) throw Error('Codex repository unavailable')
  const root = resolve(repositoryRoot), common = join(root, '.git'), worktrees = join(common, 'worktrees'), dotGit = join(cwd, '.git')
  await ownedGitDirectory(common); await ownedGitDirectory(worktrees)
  const pointer = await readGitMetadata(dotGit)
  const target = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(pointer.text)?.[1]
  if (!target || !isAbsolute(target) || dirname(target) !== worktrees || resolve(target) !== target) throw Error('Codex worktree unavailable')
  await ownedGitDirectory(target)
  const back = await readGitMetadata(join(target, 'gitdir')), parent = await readGitMetadata(join(target, 'commondir'))
  const onePath = (raw: string) => /^[^\r\n\0]+\r?\n?$/.test(raw) ? raw.replace(/\r?\n$/, '') : undefined
  const backPath = onePath(back.text), parentPath = onePath(parent.text)
  if (!backPath || resolve(target, backPath) !== dotGit || !parentPath || resolve(target, parentPath) !== common ||
    !await absent(join(target, 'config.worktree')) || !await absent(join(common, 'config.worktree'))) throw Error('Codex worktree binding unavailable')
  return { root, dotGit, common, target, metadata: [pointer, back, parent] }
}

/** The user configuration directory has already been checked separately.
 * Only that exact canonical HOME/.codex is not a project layer. HOME/.agents
 * and all other ancestor configuration remain relevant. */
async function noProjectLayers(cwd: string, home: string, requireRepository: boolean, registeredGitFile?: string): Promise<boolean> {
  if (!isAbsolute(cwd) || await realpath(cwd) !== resolve(cwd)) return false
  let directory = cwd, foundRepository = false
  for (let depth = 0; depth < 128; depth++) {
    for (const name of ['.codex', '.agents']) {
      if (name === '.codex' && directory === home) continue
      if (!await absent(join(directory, name))) return false
    }
    const git = join(directory, '.git')
    if (!await absent(git)) {
      const metadata = await lstat(git)
      // A .git file may point at a second repository's hooks/config layers.
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && git !== registeredGitFile)) return false
      foundRepository = true
    }
    if (directory === parse(directory).root) return !requireRepository || foundRepository
    directory = dirname(directory)
  }
  return false
}

export async function codexAnonymousParkingEligible(cwd: string, env: Record<string, string | undefined>): Promise<boolean> {
  try { return await codexAnonymousHomeEligible(env) && await noProjectLayers(cwd, env.HOME!, false) }
  catch { return false }
}

/** Final qualification before any login. Only a worktree whose metadata agrees
 * with the daemon's already-proven primary clone may use the initialized child.
 * The native loader also consults that main checkout for project hooks. */
export async function codexAnonymousRepositoryEligible(cwd: string, env: Record<string, string | undefined>, systemSkills?: CodexSystemSkills, repositoryRoot?: string): Promise<boolean> {
  try {
    if (!await codexAnonymousHomeEligible(env, systemSkills) || !isAbsolute(cwd) || await realpath(cwd) !== resolve(cwd)) return false
    const metadata = await lstat(join(cwd, '.git'))
    if (metadata.isDirectory()) {
      if (repositoryRoot && resolve(repositoryRoot) !== resolve(cwd)) return false
      return noProjectLayers(cwd, env.HOME!, true)
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !repositoryRoot) return false
    const linked = await registeredWorktree(cwd, repositoryRoot)
    if (!await noProjectLayers(linked.root, env.HOME!, true) ||
      !await noProjectLayers(cwd, env.HOME!, true, linked.dotGit)) return false
    // Refuse a substituted/backlink-changed worktree before returning authority.
    for (const before of linked.metadata) {
      const after = await readGitMetadata(before.path)
      if (before.text !== after.text || before.signature !== after.signature) return false
    }
    await ownedGitDirectory(linked.common); await ownedGitDirectory(linked.target)
    return true
  } catch { return false }
}
