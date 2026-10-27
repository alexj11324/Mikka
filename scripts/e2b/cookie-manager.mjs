// Owner-scoped cookie exchange inside one Bot machine. The Unix socket and
// state directory are private to the machine's unprivileged browser account.
// Merge only changes since the caller's last snapshot, so an idle browser
// cannot overwrite a newer login from another Bot or subagent.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

const root = '/home/user/.mikka/shared-cookies'
mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
const socketPath = `${root}/manager.sock`, file = `${root}/cookies.json`
try { unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
function key(cookie) { return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]) }
function mapCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length > 5000) throw new Error('Invalid cookie state')
  const map = new Map()
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' || typeof cookie.value !== 'string') throw new Error('Invalid cookie')
    map.set(key(cookie), cookie)
  }
  return map
}
function merge(baseline, current) {
  let saved = []
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const shared = mapCookies(saved), before = mapCookies(baseline), after = mapCookies(current)
  for (const [id, old] of before) if (!after.has(id) && JSON.stringify(shared.get(id)) === JSON.stringify(old)) shared.delete(id)
  for (const [id, cookie] of after) if (JSON.stringify(cookie) !== JSON.stringify(before.get(id))) shared.set(id, cookie)
  const result = [...shared.values()]
  if (result.length > 5000) throw new Error('Cookie limit reached')
  writeFileSync(`${file}.next`, JSON.stringify(result), { mode: 0o600 }); renameSync(`${file}.next`, file)
  return result
}
createServer(client => {
  let buffer = ''
  client.on('data', chunk => {
    buffer += chunk.toString()
    if (buffer.length > 8 * 1024 * 1024) { client.destroy(); return }
    const end = buffer.indexOf('\n')
    if (end < 0) return
    try { const request = JSON.parse(buffer.slice(0, end)); client.end(JSON.stringify({ cookies: merge(request.baseline, request.current) }) + '\n') }
    catch { client.end('{"error":"Cookie state unavailable"}\n') }
  })
}).listen(socketPath, () => chmodSync(socketPath, 0o600))
