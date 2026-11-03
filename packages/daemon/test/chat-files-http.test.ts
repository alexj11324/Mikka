import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { HttpServerLink } from '../src/server-link-http'
import type { RunAssignment } from '../src/server-link'

it('large file downloads use the private storage capability without forwarding the device credential', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024, 42)
  const file = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'large.png',
    mediaType: 'image/png',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    text: null,
    downloadUrl: 'https://account.r2.cloudflarestorage.com/bucket/private?signature=fixture',
  }
  let storageReads = 0
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).includes('/register')) return new Response(null, { status: 204 })
    const headers = new Headers(init?.headers)
    if (new URL(String(url)).hostname.endsWith('.r2.cloudflarestorage.com')) {
      storageReads++
      expect(headers.get('authorization')).toBeNull()
      expect(headers.get('cookie')).toBeNull()
      expect(headers.get('x-vercel-protection-bypass')).toBeNull()
      expect(init?.redirect).toBe('error')
      return new Response(bytes)
    }
    expect(headers.get('authorization')).toBe('Bearer private-device-session')
    return Response.json(file)
  }) as typeof fetch
  const link = new HttpServerLink('https://mikka.invalid/mikka', fetcher)
  await link
    .registerDevice('private-device-session', {
      name: 'fixture',
      platform: 'linux',
      arch: 'x64',
      daemonVersion: '1',
      protocolVersion: 3,
      harnesses: [],
    })
    .catch(() => {})
  const received = await link.downloadChatFile(
    { runId: 'run', deviceId: 'device' } as RunAssignment,
    file.id,
    new AbortController().signal,
  )
  expect(Buffer.from(received.data, 'base64')).toEqual(bytes)
  expect(storageReads).toBe(1)
})

it('a download capability cannot select a different origin or exceed its authorized file size', async () => {
  const file = {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'file.md',
    mediaType: 'text/markdown',
    size: 1,
    sha256: 'a'.repeat(64),
    text: null,
    downloadUrl: 'http://127.0.0.1/private',
  }
  const assignment = { runId: 'run', deviceId: 'device' } as RunAssignment
  let external = false,
    cancelled = false
  const fetcher = (async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).startsWith('https://mikka.invalid')) return Response.json(file)
    external = true
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  }) as typeof fetch
  const link = new HttpServerLink('https://mikka.invalid/mikka', fetcher)
  await expect(link.downloadChatFile(assignment, file.id, new AbortController().signal)).rejects.toThrow(
    'origin',
  )
  expect(external).toBe(false)
  file.downloadUrl = 'https://account.r2.cloudflarestorage.com/private'
  await expect(link.downloadChatFile(assignment, file.id, new AbortController().signal)).rejects.toThrow(
    'content mismatch',
  )
  expect(cancelled).toBe(true)
})
