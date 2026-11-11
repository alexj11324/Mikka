import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Hosted Ubuntu images can select Azure through a direct URI or apt's mirror
// lists. Change only those Ubuntu endpoints, retaining apt's trust settings.
function officialUri(uri, security) {
  if (!/^https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?$/.test(uri) &&
      !/^mirror\+file:\/{1,3}etc\/apt\/apt-mirrors(?:-security)?\.txt$/.test(uri)) return uri
  return security ? 'http://security.ubuntu.com/ubuntu' : 'http://archive.ubuntu.com/ubuntu'
}

export function rewriteSources(source, deb822) {
  if (!deb822) {
    return source.replace(/^(\s*deb(?:-src)?\s+(?:\[[^\]\n]*\]\s+)?)(\S+)(\s+)(\S+)(.*)$/gm,
      (_, prefix, uri, space, suite, rest) => prefix + officialUri(uri, suite.endsWith('-security')) + space + suite + rest)
  }
  return source.split(/(\n[ \t]*\n)/).map(stanza => {
    const suites = stanza.match(/^Suites:[ \t]*(.+)$/m)?.[1].trim().split(/\s+/)
    if (!suites) return stanza
    const security = suites.filter(suite => suite.endsWith('-security'))
    const archive = suites.filter(suite => !suite.endsWith('-security'))
    const replace = (text, isSecurity) => text.replace(/^(URIs:[ \t]*)(.+)$/m,
      (_, prefix, uris) => prefix + uris.replace(/\S+/g, uri => officialUri(uri, isSecurity)))
    // Retain all suites even if an image combines archive and security in one
    // stanza. Both stanzas keep its components, architecture and Signed-By.
    if (security.length && archive.length && replace(stanza, false) !== stanza) {
      return [archive, security].map((group, i) => replace(
        stanza.replace(/^Suites:[ \t]*.+$/m, 'Suites: ' + group.join(' ')), i === 1)).join('\n\n')
    }
    return replace(stanza, security.length > 0)
  }).join('')
}

export function configureUbuntuApt({ root = '/', platform = process.platform } = {}) {
  if (platform !== 'linux') return []
  const release = join(root, 'etc/os-release')
  if (!existsSync(release) || !/^ID=["']?ubuntu["']?\s*$/m.test(readFileSync(release, 'utf8'))) return []
  const changed = []
  for (const relative of ['etc/apt/sources.list', 'etc/apt/sources.list.d/ubuntu.sources']) {
    const path = join(root, relative)
    if (!existsSync(path)) continue
    const before = readFileSync(path, 'utf8')
    const after = rewriteSources(before, relative.endsWith('.sources'))
    if (after !== before) {
      writeFileSync(path, after)
      changed.push(relative)
    }
  }
  return changed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('Ubuntu official apt sources:', configureUbuntuApt().join(', ') || 'unchanged')
}
