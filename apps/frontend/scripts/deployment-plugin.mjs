import { posix } from 'node:path'
import ts from 'typescript'

/** Query pinning is also needed for CSS, module imports and public icons;
 * credentials and a deployment-wide browser cookie are never introduced. */
export function pinnedUrl(value, deploymentId) {
  if (!deploymentId || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value
  const hashAt = value.indexOf('#')
  const hash = hashAt < 0 ? '' : value.slice(hashAt)
  const address = hashAt < 0 ? value : value.slice(0, hashAt)
  const queryAt = address.indexOf('?')
  const path = queryAt < 0 ? address : address.slice(0, queryAt)
  const query = new URLSearchParams(queryAt < 0 ? '' : address.slice(queryAt + 1))
  query.set('dpl', deploymentId)
  return `${path}?${query}${hash}`
}

function emittedReference(value, filename, files) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return false
  const path = value.split(/[?#]/, 1)[0]
  return files.has(path.replace(/^\/mikka\//, '')) || files.has(posix.normalize(posix.join(posix.dirname(filename), path)))
}

export function pinChunkReferences(code, filename, files, deploymentId) {
  if (!deploymentId) return code
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const changes = []
  const visit = node => {
    if (ts.isStringLiteral(node) && emittedReference(node.text, filename, files)) {
      const value = pinnedUrl(node.text, deploymentId)
      if (value !== node.text) changes.push({ start: node.getStart(source), end: node.end, value: JSON.stringify(value) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const change of changes.sort((a, b) => b.start - a.start)) code = code.slice(0, change.start) + change.value + code.slice(change.end)
  return code
}

export function deploymentPlugin({ deploymentId = '' } = {}) {
  return {
    name: 'mikka-deployment-assets', enforce: 'post',
    transformIndexHtml: { order: 'post', handler(html) {
      if (!deploymentId) return html
      return html.replace(/\b(src|href)=(['"])(\/mikka\/[^'"]*)\2/g, (_all, name, quote, url) => `${name}=${quote}${pinnedUrl(url, deploymentId).replaceAll('&', '&amp;')}${quote}`)
    } },
    generateBundle(_options, bundle) {
      if (!deploymentId) return
      const files = new Set(Object.keys(bundle))
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') output.code = pinChunkReferences(output.code, output.fileName, files, deploymentId)
        else if (output.fileName.endsWith('.css')) {
          const css = typeof output.source === 'string' ? output.source : Buffer.from(output.source).toString()
          output.source = css.replace(/url\((['"]?)([^'"()]+)\1\)/g, (original, _quote, value) => emittedReference(value, output.fileName, files) ? `url(${JSON.stringify(pinnedUrl(value, deploymentId))})` : original)
        }
      }
    },
  }
}
