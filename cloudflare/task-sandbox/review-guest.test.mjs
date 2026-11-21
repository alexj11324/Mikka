import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareReviewGuest } from './review-guest.mjs'

const boot = {
  ok: true, version: 1, provider: 'cloudflare', providerPorts: [], preparedBeforeWorker: true,
  bootId: 'de102ee8-5a56-4dac-9711-a6bcad914908', sourceSha256: 'e'.repeat(64),
  rulesVerified: { ipv4: true, ipv6: true }, installedTicks: 10,
}

function commandReplies(proof, installExit = 0) {
  const seen = []
  const container = {
    async exec(argv, options) {
      seen.push({ argv, options })
      return {
        output: async () => ({
          exitCode: seen.length === 1 ? 0 : installExit,
          stdout: new TextEncoder().encode(JSON.stringify(proof)),
        }),
      }
    },
  }
  return { container, seen }
}

test('only the root image guard and control installer receive the initial boot', async () => {
  const { container, seen } = commandReplies(boot)
  assert.deepEqual(await prepareReviewGuest(container), { bootId: boot.bootId, sourceSha256: boot.sourceSha256 })
  assert.deepEqual(seen.map(command => [command.argv.at(-1), command.options.user]), [
    ['prepare-cloudflare', '0:0'], ['--cloudflare-task', '0:0'],
  ])
})

test('an unproven boot never reaches the control installer', async () => {
  for (const changed of [{ providerPorts: [49983] }, { rulesVerified: { ipv4: true } },
    { provider: 'e2b' }, { preparedBeforeWorker: false }, { bootId: '' }, { sourceSha256: '' }]) {
    const { container, seen } = commandReplies({ ...boot, ...changed })
    await assert.rejects(prepareReviewGuest(container), /ingress unavailable/)
    assert.equal(seen.length, 1)
  }
  await assert.rejects(prepareReviewGuest(commandReplies(boot, 1).container), /control unavailable/)
})
