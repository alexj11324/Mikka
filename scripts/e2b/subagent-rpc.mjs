// Trusted control-plane helper. The request lives in a private file instead
// of argv so page content and typed text do not appear in process arguments.
import { constants, closeSync, fstatSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'

const [id, requestId] = process.argv.slice(2)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
if (!uuid.test(id ?? '') || !uuid.test(requestId ?? '')) throw new Error('Invalid request')
const root = `/home/user/.mikka/subagents/${id}`
const path = `${root}/request-${requestId}.json`
const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
let request
try {
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) throw new Error('Invalid request')
  request = JSON.parse(readFileSync(fd, 'utf8'))
  unlinkSync(path)
} finally { closeSync(fd) }
request.id = requestId
const socket = createConnection(`${root}/browser.sock`)
let input = ''
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1 }, 35_000)
socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
socket.on('data', data => {
  input += data.toString()
  if (input.length > 4 * 1024 * 1024) { socket.destroy(); process.exitCode = 1; return }
  const end = input.indexOf('\n')
  if (end < 0) return
  const response = JSON.parse(input.slice(0, end))
  if (response.id !== requestId || response.error) { socket.destroy(); process.exitCode = 1; return }
  process.stdout.write(JSON.stringify(response.result ?? null)); clearTimeout(timer); socket.end()
})
socket.on('error', () => { clearTimeout(timer); process.exitCode = 1 })
