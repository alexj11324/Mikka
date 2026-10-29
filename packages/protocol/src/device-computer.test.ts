import { describe, expect, it } from 'vitest'
import { deviceHeartbeatSchema, deviceRegistration } from './device'

describe('device computer capability', () => {
  it('accepts legacy devices and reports a bounded, separate installed capability', () => {
    const registration = { name: 'device', platform: 'linux', arch: 'x64', daemonVersion: '1', protocolVersion: 2, harnesses: [] }
    expect(deviceRegistration.safeParse(registration).success).toBe(true)
    expect(deviceRegistration.safeParse({ ...registration, computerUse: { installed: true, version: 'cua-driver 0.38.0' } }).success).toBe(true)
    expect(deviceRegistration.safeParse({ ...registration, computerUse: { installed: true, version: 'x'.repeat(101) } }).success).toBe(false)
    expect(deviceRegistration.safeParse({ ...registration, computerUse: { installed: true, version: null, fingerprint: 'secret' } }).success).toBe(false)
    const heartbeat = { harnesses: [], runs: [], worktreeDiskBytes: 0 }
    expect(deviceHeartbeatSchema.safeParse(heartbeat).success).toBe(true)
    expect(deviceHeartbeatSchema.safeParse({ ...heartbeat, computerUse: { installed: false, version: null } }).success).toBe(true)
  })
})
