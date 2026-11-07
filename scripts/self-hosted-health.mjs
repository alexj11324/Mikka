import { request } from 'node:http'

const origin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:3000')
const call = request({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/mikka/api/version',
  headers: { host: origin.host }, timeout: 4_000 }, response => {
  response.resume()
  process.exitCode = response.statusCode === 200 && response.headers['content-type']?.includes('application/json') ? 0 : 1
})
call.on('timeout', () => call.destroy(new Error('health_timeout')))
call.on('error', () => { process.exitCode = 1 })
call.end()
