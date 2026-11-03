import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Pool } from 'pg'
import { PgReceiveCollector } from './transport-sample'

function fixture(enabled = true) {
  let on = enabled, clock = 1000, tick: (() => void) | undefined
  const lines: string[] = []
  const collector = new PgReceiveCollector({ on: () => on, now: () => clock, sink: line => lines.push(line), schedule: callback => { tick = callback; return () => { tick = undefined } } })
  const pool = new EventEmitter(), stream = Object.assign(new EventEmitter(), { bytesRead: 500 })
  const client = { connection: { stream } }
  collector.watch(pool as Pool, 'default')
  return { collector, pool, stream, client, lines, tick: () => { clock += 60000; tick?.() }, enable: (value: boolean) => { on = value }, hasTimer: () => Boolean(tick) }
}

test('connection counters aggregate once across acquisitions, windows and remove/close', () => {
  const f = fixture(); f.collector.watch(f.pool as Pool, 'default')
  f.pool.emit('connect', f.client); f.pool.emit('acquire', f.client)
  f.stream.bytesRead += 400; f.pool.emit('acquire', f.client); f.tick()
  assert.equal(JSON.parse(f.lines[0]).pgProtocolReceiveBytes, 400)
  f.stream.bytesRead += 100; f.pool.emit('remove', f.client); f.stream.emit('close')
  assert.equal(f.lines.length, 2)
  assert.equal(JSON.parse(f.lines[1]).pgProtocolReceiveBytes, 100)
  assert.equal(f.hasTimer(), false)
  assert.ok(f.lines.every(line => JSON.parse(line).startupExcluded))
})

test('a gate enabled after connect excludes off-period bytes, and can restart', () => {
  const f = fixture(false); f.pool.emit('connect', f.client)
  assert.equal(f.hasTimer(), false)
  f.stream.bytesRead += 900; f.enable(true); f.pool.emit('acquire', f.client)
  f.stream.bytesRead += 30; f.tick()
  assert.equal(JSON.parse(f.lines[0]).pgProtocolReceiveBytes, 30)
  f.enable(false); f.pool.emit('acquire', f.client)
  f.stream.bytesRead += 1000; f.enable(true); f.pool.emit('acquire', f.client)
  f.stream.bytesRead += 40; f.tick()
  assert.equal(JSON.parse(f.lines[1]).pgProtocolReceiveBytes, 40)
})

test('missing and decreasing counters are marked incomplete rather than zero success', () => {
  const f = fixture(); f.pool.emit('connect', f.client)
  Object.defineProperty(f.stream, 'bytesRead', { value: undefined, configurable: true }); f.tick()
  assert.equal(JSON.parse(f.lines[0]).coverage, 'incomplete')
  assert.equal(JSON.parse(f.lines[0]).unknownReadings, 1)
  assert.equal(JSON.parse(f.lines[0]).pgProtocolReceiveBytes, null)
  Object.defineProperty(f.stream, 'bytesRead', { value: 1, configurable: true }); f.tick()
  assert.equal(JSON.parse(f.lines[1]).coverage, 'incomplete')
  Object.defineProperty(f.stream, 'bytesRead', { value: 0, configurable: true }); f.tick()
  assert.equal(JSON.parse(f.lines[2]).pgProtocolReceiveBytes, null)
})
