import assert from 'node:assert/strict'
import test from 'node:test'
import { BundledLive } from './bundled-live'

const channel = 'a'.repeat(64)
function fixture(url: string) {
  const auth = {
    session: () => ({ user: { id: 'owner' }, session: { id: 'session' } }),
    request: async () => Response.json({ url, protocol: 'test-ticket', expiresAt: Date.now() + 30_000 }),
  }
  return new BundledLive(auth as unknown as ConstructorParameters<typeof BundledLive>[0], () => {})
}

test('accepts the actual community ticket base path and the existing Worker ticket path', async () => {
  for (const url of [`ws://localhost:3000/mikka/v1/live/${channel}/socket`,
    `wss://self.example/mikka/v1/live/${channel}/socket`, `wss://gateway.example/v1/live/${channel}/socket`]) {
    const live = fixture(url)
    const ticket = await live.prepare(1, 'workspace')
    assert.ok(ticket?.id)
    live.close(1, ticket.id)
  }
})

test('retains exact channel paths, TLS and ticket URL boundaries', async () => {
  for (const url of [`ws://self.example/mikka/v1/live/${channel}/socket`,
    `wss://self.example/other/v1/live/${channel}/socket`, `wss://self.example/mikka/v1/live/other/socket`,
    `wss://self.example/mikka/v1/live/${channel}/socket?token=private`,
    `wss://user:private@self.example/mikka/v1/live/${channel}/socket`,
    `wss://self.example/mikka/v1/live/${channel}/socket#fragment`]) {
    await assert.rejects(fixture(url).prepare(1, 'workspace'), /Invalid live ticket/)
  }
})
