import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** GitHub runner-images tries Azure first through mirror+file. Keep its
 * existing signed Ubuntu sources and official fallback list, bypassing the
 * failing preference before Playwright invokes apt in the disposable runner.
 * https://github.com/actions/runner-images/issues/14594
 * https://github.com/actions/runner-images/issues/15142 */
export function skipAzureMirror(source) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const azure = line => /^https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?:\s|$)/.test(line.trim())
  if (!lines.some(azure)) return source
  const keep = lines.filter(line => !azure(line))
  if (!keep.some(line => /^https:\/\/(?:archive|security)\.ubuntu\.com\/ubuntu\/?(?:\s|$)/.test(line.trim())))
    throw Error('ci_apt_official_fallback_missing')
  return keep.join('')
}

export async function prepareAptMirrors(file = '/etc/apt/apt-mirrors.txt') {
  let source
  try { source = await readFile(file, 'utf8') }
  catch (cause) {
    if (cause.code === 'ENOENT') return { changed: false, reason: 'mirror_list_absent' }
    throw Error('ci_apt_mirror_read_failed', { cause })
  }
  const next = skipAzureMirror(source)
  if (next !== source) await writeFile(file, next)
  return { changed: next !== source, reason: next !== source ? 'azure_mirror_removed' : 'already_prepared' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ event: 'ci_apt_mirrors', ...await prepareAptMirrors(process.argv[2]) }))
