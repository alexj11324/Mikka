import { dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import type { PickRepoResult } from '@mikka/protocol/bridge'

const exec = promisify(execFile)
/** User chooses a directory; no renderer-supplied path, command or arguments. */
export async function pickRepo(): Promise<PickRepoResult> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  const path = result.filePaths[0]
  if (result.canceled || !path) return { status: 'cancelled' }
  try {
    const { stdout } = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel'], { timeout: 10_000, maxBuffer: 8192, windowsHide: true })
    const root = stdout.trim()
    let remoteUrl: string | null = null
    try { remoteUrl = (await exec('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 10_000, maxBuffer: 8192, windowsHide: true })).stdout.trim() || null } catch { /* A repository need not have a remote. */ }
    // Never send URL userinfo (embedded Git credentials) back to a renderer.
    if (remoteUrl && /^https?:/i.test(remoteUrl)) { const url = new URL(remoteUrl); url.username = ''; url.password = ''; remoteUrl = url.href }
    return { status: 'picked', repo: { path: root, name: basename(root), remoteUrl } }
  } catch { return { status: 'not_a_repo', path } }
}
