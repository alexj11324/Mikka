import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { test } from 'node:test'
import { createAuthEmail, type AuthMailContext } from './auth-email'
import { deliverMail, mailConfigured } from './mail-delivery'

test('SMTP sends verification and reset mail through the same configured sender without Resend', async t => {
  const messages: string[] = [], senders: string[] = [], sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.write('220 fixture ESMTP\r\n')
    let buffered = '', data = false, message: string[] = []
    socket.on('data', chunk => {
      buffered += chunk.toString()
      for (;;) {
        const end = buffered.indexOf('\r\n')
        if (end < 0) break
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 2)
        if (data) {
          if (line === '.') { messages.push(message.join('\r\n')); message = []; data = false; socket.write('250 accepted\r\n') }
          else message.push(line.replace(/^\.\./, '.'))
        } else if (line.startsWith('EHLO ')) socket.write('250-fixture\r\n250 8BITMIME\r\n')
        else if (line.startsWith('MAIL FROM:')) { senders.push(line); socket.write('250 sender\r\n') }
        else if (line.startsWith('RCPT TO:')) socket.write('250 recipient\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n') }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  const names = ['SMTP_URL', 'MIKKA_EMAIL_FROM', 'RESEND_API_KEY'] as const
  const previous = names.map(key => process.env[key])
  Object.assign(process.env, { SMTP_URL: `smtp://127.0.0.1:${(server.address() as { port: number }).port}`, MIKKA_EMAIL_FROM: 'Our Mikka <login@example.test>' })
  delete process.env.RESEND_API_KEY
  t.after(() => names.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] }))
  assert.equal(mailConfigured(), true)
  const context: AuthMailContext = { secret: 'synthetic-test-only', internalAdapter: {
    reserveVerificationValue: async () => true, consumeVerificationValue: async () => null,
    findVerificationValue: async () => null, findUserById: async () => null, updateUser: async () => null,
  } }
  const origin = 'https://self-hosted.example.test'
  const email = createAuthEmail({ origin, apiKey: () => undefined, context: async () => context,
    fetch: async () => { throw new Error('Resend must not be used with SMTP') } })
  await email.emailVerification.sendVerificationEmail({ user: { id: 'u', email: 'recipient@example.test' }, token: 'verify-fixture', url: `${origin}/mikka/api/auth/verify-email?token=verify-fixture` })
  await email.emailAndPassword.sendResetPassword({ user: { id: 'u', email: 'recipient@example.test' }, token: 'reset-fixture', url: `${origin}/mikka/api/auth/reset-password/reset-fixture` })
  assert.equal(messages.length, 2)
  for (const sender of senders) assert.equal(sender, 'MAIL FROM:<login@example.test>')
  assert.match(messages[0], /Subject: Verify your Mikka email address/)
  assert.match(messages[1], /Subject: Reset your Mikka password/)
  assert.ok(messages.every(message => message.includes('From: Our Mikka <login@example.test>')))
  assert.ok(messages.every(message => !message.includes('aspectlylabs.com')))
})

test('Resend keeps acceptance and idempotency checks while errors stay redacted', async () => {
  const message = { to: 'recipient@example.test', subject: 'Synthetic test', text: 'Fixture body', idempotencyKey: 'fixture-key' }
  await deliverMail(message, { env: { RESEND_API_KEY: 'synthetic-secret', MIKKA_EMAIL_FROM: 'ours@example.test' }, fetch: async (_url, options) => {
    assert.equal(new Headers(options?.headers).get('idempotency-key'), 'fixture-key')
    assert.equal(JSON.parse(String(options?.body)).from, 'ours@example.test')
    assert.equal(options?.redirect, 'error')
    return Response.json({ id: 'accepted' })
  } })
  await assert.rejects(deliverMail(message, { env: { SMTP_URL: 'https://synthetic-secret@example.test' } }), { message: 'mail_delivery_unavailable' })
  await assert.rejects(deliverMail(message, { env: { RESEND_API_KEY: 'fixture' }, fetch: async () => Response.json({}) }), { message: 'mail_delivery_unavailable' })
})
