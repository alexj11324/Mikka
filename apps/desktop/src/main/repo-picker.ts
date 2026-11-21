import { dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import type { PickRepoResult } from '@mikka/protocol/bridge'

const exec = promisify(execFile)
const gitOptions = { timeout: 10_000, maxBuffer: 8192, windowsHide: true }
/** User chooses a directory; no renderer-supplied path, command or arguments. */
export async function pickRepo(): Promise<PickRepoResult> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  const path = result.filePaths[0]
  if (result.canceled || !path) return { status: 'cancelled' }
  try {
    const { stdout } = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel'], gitOptions)
    const root = stdout.trim()
    const readGit = async (...args: string[]) => {
      try { return (await exec('git', ['-C', root, ...args], gitOptions)).stdout.trim() || null } catch { return null }
    }
    let remoteUrl = await readGit('remote', 'get-url', 'origin')
    if (!remoteUrl) {
      const first = (await readGit('remote'))?.split('\n')[0]
      if (first && first !== 'origin') remoteUrl = await readGit('remote', 'get-url', '--', first)
    }
    // Never send URL userinfo (embedded Git credentials) back to a renderer.
    if (remoteUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
      const url = new URL(remoteUrl)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      remoteUrl = url.href
    }
    return { status: 'picked', repo: { path: root, name: basename(root), remoteUrl } }
  } catch { return { status: 'not_a_repo', path } }
}
