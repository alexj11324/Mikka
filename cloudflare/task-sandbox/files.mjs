import { Files, SandboxFileError } from '@cloudflare/sandbox'

const user = { user: '1000:1000' }
const maxBytes = 4 * 1024 * 1024

export function parts(path) {
  if (typeof path !== 'string' || !path.startsWith('/workspace/') || path.length > 4096 || path.includes('\0')) throw new Error('Invalid task workspace path')
  const names = path.slice('/workspace/'.length).split('/')
  if (names.some(s => !s || s === '.' || s === '..')) throw new Error('Invalid task workspace path')
  return names
}

// These workspace operations are serialized by the task DO. The metadata
// channel never follows a repository symlink into the runtime credential home.
export class TaskFiles {
  constructor(container) { this.files = new Files(container) }
  async inspect(path) {
    try { return await this.files.lstat(path, user) }
    catch (error) { if (SandboxFileError.is(error) && error.code === 'ENOENT') return null; throw error }
  }
  async target(path, createParents, allowNonFile = false) {
    const names = parts(path)
    let dir = '/workspace'
    for (const name of names.slice(0, -1)) {
      dir += '/' + name
      const info = await this.inspect(dir)
      if (!info) {
        if (!createParents) return null
        await this.files.mkdir(dir, user)
      } else if (info.type !== 'directory') throw new Error('Task workspace path is not a directory')
    }
    const info = await this.inspect(path)
    if (!allowNonFile && info && info.type !== 'file') throw new Error('Task workspace path is not a regular file')
    return { path, info }
  }
  async remove(path, { force = false, recursive = false } = {}) {
    if (typeof force !== 'boolean' || typeof recursive !== 'boolean') throw Error('Invalid task file removal')
    const target = await this.target(path, false, true)
    if (!target?.info) {
      if (force) return
      throw Error('Task workspace path does not exist')
    }
    // remove unlinks the leaf itself and does not follow a repository symlink.
    await this.files.remove(path, { ...user, force, recursive })
  }
  async read(path) {
    const target = await this.target(path, false)
    if (!target?.info) return null
    if (target.info.size > BigInt(maxBytes)) throw new Error('Task file exceeds read limit')
    return new Uint8Array(await (await this.files.readFile(path, user)).arrayBuffer())
  }
  async write(path, content) {
    if (!(content instanceof Uint8Array) || content.byteLength > maxBytes) throw new Error('Invalid task file bytes')
    await this.target(path, true)
    await this.files.writeFile(path, content, user)
  }
}
