import { DirectoryBackup } from '@cloudflare/sandbox'

const path = '/workspace'
const uuidArchive = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tar\.zst$/

// The task DO owns the manifest. The SDK gateway has an R2 binding scoped
// to a single archive for each operation. The VM never receives an R2 key.
export class TaskWorkspace {
  constructor(ctx, bucket) {
    this.storage = ctx.storage
    this.bucket = bucket
    this.prefix = 'task-workspaces/v1/' + ctx.id.toString() + '/'
    this.backups = new DirectoryBackup(ctx.container, ctx.exports.DirectoryBackupGateway, {
      binding: 'WORKSPACES', prefix: this.prefix,
    })
  }

  async restore() {
    const prior = await this.storage.get('checkpoint')
    if (!prior) return false
    await this.backups.restore(prior, { dir: path, signal: AbortSignal.timeout(55_000) })
    return true
  }

  // The caller fences new work and establishes a writer-free safe point.
  async checkpoint() {
    const saved = await this.backups.backup({
      dir: path, signal: AbortSignal.timeout(55_000),
      // Native CLI login, Git credentials and other platform secrets live in
      // the runtime home outside this directory. Do not archive repository-
      // local credential stores or transient filesystem sockets either.
      exclude: ['.git/credentials', '.git-credentials', '.netrc'],
    })
    await this.storage.put('checkpoint', saved)
    return { id: saved.id, bytes: saved.size, sha256: saved.sha256 }
  }

  // Sweep after commit or crash. Only this task's archive names are eligible.
  // A crash between external upload and local manifest commit leaves an orphan
  // under this prefix, so deleting only the old manifest would be insufficient.
  async prune() {
    const saved = await this.storage.get('checkpoint')
    // A first upload can finish before the first manifest is committed.
    const keep = saved && this.prefix + saved.id + '.tar.zst'
    let cursor
    do {
      const page = await this.bucket.list({ prefix: this.prefix, cursor, limit: 100 })
      const obsolete = page.objects.map(o => o.key).filter(key =>
        key !== keep && key.startsWith(this.prefix) && uuidArchive.test(key.slice(this.prefix.length)))
      if (obsolete.length) await this.bucket.delete(obsolete)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }
}
