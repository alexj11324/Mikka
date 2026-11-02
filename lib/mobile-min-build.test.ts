import assert from 'node:assert/strict'
import test from 'node:test'
import { GET } from '../app/api/version/route'
import { MIN_MOBILE_BUILD } from './mobile-min-build'

test('/api/version tells the iOS app the oldest build it accepts and where to update', async () => {
  const body = await GET().json() as { minMobileBuild: unknown; mobileUpdateUrl: unknown }
  assert.equal(body.minMobileBuild, MIN_MOBILE_BUILD)
  assert.ok(Number.isInteger(body.minMobileBuild) && (body.minMobileBuild as number) >= 0)
  assert.match(String(body.mobileUpdateUrl), /^itms-(beta|apps):\/\//)
})
