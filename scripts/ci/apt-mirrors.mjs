import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Ubuntu's registered HTTPS archive mirror has independent DNS. Ubuntu's own
// DNS outage on 2026-11-11 also affected archive/security, so removing only
// Azure is insufficient. Keep mirror+file and the original Signed-By keyring:
// the mirror transports the same Ubuntu-signed indexes and hashed packages.
// https://status.canonical.com/ (DNS incident, 2026-11-11 14:26 UTC)
// https://github.com/actions/runner-images/issues/15296
// https://launchpad.net/ubuntu/+mirror/mirror.umd.edu-archive
export const ubuntuHttpsMirror = 'https://mirror.umd.edu/ubuntu/'

export function prepareMirrorList(source) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const azure = line => /^https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?:\s|$)/.test(line.trim())
  const official = line => /^https:\/\/(?:archive|security)\.ubuntu\.com\/ubuntu\/?(?:\s|$)/.test(line.trim())
  if (!lines.some(official)) {
    if (lines.some(azure)) throw Error('ci_apt_official_fallback_missing')
    return source
  }
  const preferred = line => /^https:\/\/mirror\.umd\.edu\/ubuntu\/?(?:\s|$)/.test(line.trim())
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const keep = lines.filter(line => !azure(line) && !preferred(line))
  return ubuntuHttpsMirror + '\tpriority:1' + newline + keep.join('')
}

export async function prepareAptMirrors(file = '/etc/apt/apt-mirrors.txt') {
  let source
  try { source = await readFile(file, 'utf8') }
  catch (cause) {
    if (cause.code === 'ENOENT') return { changed: false, reason: 'mirror_list_absent' }
    throw Error('ci_apt_mirror_read_failed', { cause })
  }
  const next = prepareMirrorList(source)
  if (next !== source) await writeFile(file, next)
  return { changed: next !== source, reason: next !== source ? 'independent_https_mirror_preferred' : 'already_prepared' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ event: 'ci_apt_mirrors', ...await prepareAptMirrors(process.argv[2]) }))
