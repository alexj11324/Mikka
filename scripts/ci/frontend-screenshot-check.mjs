/**
 * Frontend pull requests must show the change. LobeHub's admission check
 * requires acceptance evidence in the description; Mikka requires an actual
 * screenshot or recording when the diff touches the interface.
 *
 * A line `Screenshots: not needed: <reason>` opts out. The reason has to say
 * why nothing visual changed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const FRONTEND_VISUAL = /^(?:components|hooks|apps\/frontend|messages)\//

const stripComments = (text) => {
  let result = ''
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<!--', cursor)
    if (start === -1) return result + text.slice(cursor)
    result += text.slice(cursor, start)
    const end = text.indexOf('-->', start + 4)
    if (end === -1) return result
    cursor = end + 3
  }
  return result
}

const OPT_OUT = /screenshots?:\s*not needed:\s*(\S(?:.|\n){7,})/i
const IMAGE = /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\)|\[[^\]]*\]\(\s*https?:\/\/[^)\s]*\.(?:png|jpe?g|gif|webp|mp4|mov)(?:[?#][^)\s]*)?\)|<img\b(?![^>]*\bsrc\s*=\s*["']https:\/\/cursor\.com\/assets\/images\/open-in-)[^>]*\bsrc\s*=\s*["']https?:\/\/|<video\b[^>]*\bsrc\s*=\s*["']https?:\/\/|https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+|https:\/\/private-user-images\.githubusercontent\.com\/\S+/i

export function isFrontendVisual(file) {
  return FRONTEND_VISUAL.test(file)
    || (file.startsWith('apps/mobile/') && /\.(?:tsx|css)$/.test(file))
    || file.startsWith('apps/desktop/src/renderer/')
    || (file.startsWith('app/') && /\.(?:tsx|css)$/.test(file))
}

export function hasScreenshot(body) {
  const text = stripComments(body ?? '')
  const optOut = text.match(OPT_OUT)
  if (optOut && !/^(?:\.{3}|…|todo|tbd|n\/a|none)$/i.test(optOut[1].trim())) return true
  return IMAGE.test(text)
}

export function missingScreenshots(files, body) {
  const visual = files.filter(isFrontendVisual)
  if (visual.length === 0 || hasScreenshot(body)) return []
  return visual
}

function changedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  return out.split('\n').map(line => line.trim()).filter(Boolean)
}

function main() {
  if (!process.env.GITHUB_EVENT_PATH) return
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const pr = event.pull_request
  if (!pr?.base?.sha) return
  const missing = missingScreenshots(changedFiles(pr.base.sha), pr.body ?? '')
  if (missing.length === 0) {
    console.log('Frontend screenshot check passed.')
    return
  }
  console.error('This pull request changes the interface but its description has no screenshot or recording.')
  console.error('Add an image or video to the description, or a line: Screenshots: not needed: <reason>.')
  console.error(missing.map(file => `- ${file}`).join('\n'))
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
