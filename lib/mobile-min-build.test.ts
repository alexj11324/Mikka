import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../app/api/version/route'
import { MIN_MOBILE_BUILD } from './mobile-min-build'
import { HOSTED_API_FLOOR, HOSTED_API_HEADERS, HOSTED_API_VERSION } from '@mikka/protocol/version'

test('/api/version tells the iOS app the oldest build it accepts and where to update', async () => {
  const body = await (await GET(new Request('https://mikka.test/mikka/api/version'))).json() as { minMobileBuild: unknown; mobileUpdateUrl: unknown }
  assert.equal(body.minMobileBuild, MIN_MOBILE_BUILD)
  assert.ok(Number.isInteger(body.minMobileBuild) && (body.minMobileBuild as number) >= 0)
  assert.match(String(body.mobileUpdateUrl), /^itms-(beta|apps):\/\//)
  assert.deepEqual(Object.keys(body).sort(), ['build', 'minDesktopVersion', 'minMobileBuild', 'mobileUpdateUrl', 'overlaySha'], 'released Web parsers still receive their exact document')
  const compatible = await (await GET(new Request('https://mikka.test/mikka/api/version', { headers: HOSTED_API_HEADERS }))).json()
  assert.deepEqual(compatible, { ...body, apiVersion: HOSTED_API_VERSION, minApiVersion: HOSTED_API_FLOOR })
})
