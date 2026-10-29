import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudDeviceScopeAllows } from './device-token-scope'

const own = '0b542a36-6840-4750-93e6-d6b775561732'
const other = 'd3f47b96-7458-4a3b-ae72-59498c456f81'
const run = '1b77c435-6491-4927-9f7c-58805065d837'
const belongs = async (id: string, device: string) => id === run && device === own
const req = (path: string, init?: RequestInit) => new Request(`https://mikka.example${path}`, init)

test('cloud device token admits only its own explicit daemon routes', async () => {
  for (const path of [`/v1/devices/${own}/heartbeat`, `/mikka/v1/devices/${own}/runs`, `/v1/devices/${own}/runs/${run}/claim`, `/v1/runs/${run}/events`, `/v1/runs/${run}/tool-approval`]) assert.equal(await cloudDeviceScopeAllows(req(path), own, belongs), true)
  for (const path of [`/v1/devices/${other}/heartbeat`, `/v1/devices/${own}/runs/${other}/claim`, `/v1/runs/${other}/events`, `/v1/runs/${other}/tool-approval`, `/v1/devices/${own}/coordinator`, `/v1/devices/${own}/runs/${run}/future`, '/api/subscriptions', '/v1/devices/other']) assert.equal(await cloudDeviceScopeAllows(req(path), own, belongs), false)
})
test('registration must explicitly name the bound device', async () => {
  for (const [deviceId, expected] of [[own, true], [other, false], [undefined, false]] as const) {
    const request = req('/mikka/v1/devices/register', { method: 'POST', body: JSON.stringify({ deviceId }) })
    assert.equal(await cloudDeviceScopeAllows(request, own, belongs), expected)
    assert.deepEqual(await request.json(), deviceId ? { deviceId } : {})
  }
  assert.equal(await cloudDeviceScopeAllows(req('/v1/devices/register'), own, belongs), false)
})
test('cloud device token reaches only its own run\'s capture routes', async () => {
  const capture = '5c0b8a0e-31b2-4a7e-9d0e-6a8f0c2d9b11'
  for (const path of [`/v1/runs/${run}/screen`, `/v1/runs/${run}/captures`, `/v1/runs/${run}/captures/${capture}`, `/mikka/v1/runs/${run}/captures/${capture}/complete`]) assert.equal(await cloudDeviceScopeAllows(req(path), own, belongs), true)
  for (const path of [`/v1/runs/${other}/screen`, `/v1/runs/${other}/captures`, `/v1/runs/${run}/captures/${capture}/share`, `/v1/runs/${run}/captures/not-a-capture-id`, `/v1/runs/${run}/screen/extra`]) assert.equal(await cloudDeviceScopeAllows(req(path), own, belongs), false)
})
