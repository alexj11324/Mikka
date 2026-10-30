import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountMailConfigured, sendAccountMail } from './mail'

const message = { to: 'alice@example.com', subject: 'Your Mikka data export', text: 'link' }

test('account mail is sent only when the provider is configured and accepts it', async () => {
  assert.equal(accountMailConfigured({}), false)
  assert.equal(accountMailConfigured({ RESEND_API_KEY: 're_test' }), true)

  let fetched = 0
  const fetchStub = (response: Response) => (async () => { fetched++; return response }) as unknown as typeof fetch
  assert.equal(await sendAccountMail(message, { apiKey: '', fetch: fetchStub(Response.json({ id: 'x' })) }), 'unavailable')
  assert.equal(fetched, 0)

  let sent: { url: string; init: RequestInit } | null = null
  const accept = (async (url: string, init: RequestInit) => { sent = { url, init }; return Response.json({ id: 'email_1' }) }) as unknown as typeof fetch
  assert.equal(await sendAccountMail(message, { apiKey: 're_test', fetch: accept }), 'sent')
  assert.equal(sent!.url, 'https://api.resend.com/emails')
  assert.deepEqual(JSON.parse(String(sent!.init.body)).to, ['alice@example.com'])

  const originalError = console.error
  console.error = () => {}
  try {
    assert.equal(await sendAccountMail(message, { apiKey: 're_test', fetch: fetchStub(new Response('no', { status: 422 })) }), 'failed')
    assert.equal(await sendAccountMail(message, { apiKey: 're_test', fetch: fetchStub(Response.json({})) }), 'failed')
    assert.equal(await sendAccountMail(message, { apiKey: 're_test', fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch }), 'failed')
  } finally {
    console.error = originalError
  }
})
