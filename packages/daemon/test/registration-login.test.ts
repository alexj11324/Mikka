import { expect, it } from 'vitest'
import { registrationLogin } from '../src/login'

it('exchanges the one-use grant under the exact app base path and validates the credential', async () => {
  const token = `orv_${'a'.repeat(43)}`, credential = `orv_${'b'.repeat(43)}`
  const result = await registrationLogin({ serverUrl: 'https://example.com/preview/mikka', token, fetchImpl: (async (url, init) => {
    expect(String(url)).toBe('https://example.com/preview/mikka/v1/devices/enroll')
    expect(init?.headers).toEqual({ authorization: `Bearer ${token}` })
    expect(init?.redirect).toBe('error')
    return Response.json({ credential })
  }) as typeof fetch })
  expect(result).toBe(credential)
})
it('refuses spent grants and web-session credentials', async () => {
  const token = `orv_${'a'.repeat(43)}`
  for (const response of [Response.json({}, { status: 401 }), Response.json({ credential: 'web-session' })]) {
    await expect(registrationLogin({ serverUrl: 'https://example.com/mikka', token, fetchImpl: (async () => response) as typeof fetch })).rejects.toThrow('expired or already used')
  }
})
