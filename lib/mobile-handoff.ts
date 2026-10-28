import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

const stateSchema = z.object({ cookies: z.array(z.string()).min(1).max(16), target: z.string(), origin: z.string().url(), csrf: z.string(), expires: z.number() }).strict()
export type MobileHandoff = z.infer<typeof stateSchema>
const key = (secret: string) => createHash('sha256').update('mikka-mobile-handoff-v1\0').update(secret).digest()

/** Pending cookies stay encrypted and HttpOnly until the browser confirms the named account. */
export function sealHandoff(state: MobileHandoff, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}
export function openHandoff(value: string, secret: string): MobileHandoff | null {
  try {
    if (value.length > 16000) return null
    const bytes = Buffer.from(value, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key(secret), bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const state = stateSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()))
    return state.expires > Date.now() ? state : null
  } catch { return null }
}
export const handoffSessionCookie = (cookies: string[]) => cookies.map(cookie => cookie.split(';')[0]).join('; ')
