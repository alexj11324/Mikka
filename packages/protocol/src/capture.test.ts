import { describe, expect, it } from 'vitest'
import { CAPTURE_MAX_BYTES, captureProblem, captureUploadRequest, screenCaptureRequest, sniffCaptureType } from './capture'

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap(part => typeof part === 'string' ? [...part].map(c => c.charCodeAt(0)) : part))
const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR')
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')
const webp = bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')
const mp4 = bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 0, 0])
const webm = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], 'webm')
const mkv = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88], 'matroska')

describe('capture contract', () => {
  it('reads the type from the bytes, never the name', () => {
    expect([png, jpeg, webp, mp4, webm].map(sniffCaptureType)).toEqual(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'])
    expect(sniffCaptureType(mkv)).toBeNull()
    expect(sniffCaptureType(bytes('<!doctype html><script>'))).toBeNull()
    expect(sniffCaptureType(new Uint8Array())).toBeNull()
  })

  it('refuses a declared type the bytes contradict, and files over the limit', () => {
    expect(captureProblem(png)).toBeNull()
    expect(captureProblem(png, 'video/mp4')).toMatch(/not video\/mp4/)
    const big = new Uint8Array(CAPTURE_MAX_BYTES.image + 1)
    big.set(png)
    expect(captureProblem(big)).toMatch(/At most/)
  })

  it('takes no owner, run or path from the caller', () => {
    const sha256 = 'a'.repeat(64)
    expect(captureUploadRequest.safeParse({ title: 'Login', contentType: 'image/png', size: 10, sha256 }).success).toBe(true)
    expect(captureUploadRequest.safeParse({ title: 'Login', contentType: 'image/png', size: 10, sha256, runId: 'x' }).success).toBe(false)
    expect(captureUploadRequest.safeParse({ title: 'Login', contentType: 'image/gif', size: 10, sha256 }).success).toBe(false)
    expect(captureUploadRequest.safeParse({ title: 'Login', contentType: 'video/mp4', size: CAPTURE_MAX_BYTES.video + 1, sha256 }).success).toBe(false)
    expect(screenCaptureRequest.safeParse({ action: 'start_recording', title: 'Flow', maxSeconds: 3600 }).success).toBe(false)
    expect(screenCaptureRequest.safeParse({ action: 'screenshot', title: 'Home', display: ':2' }).success).toBe(false)
  })
})
