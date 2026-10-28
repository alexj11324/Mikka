import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { UserModelMessage } from 'ai'

export const MAX_USER_IMAGES = 2
export const MAX_USER_IMAGE_BYTES = 1024 * 1024
export const MAX_PERSONAL_SUBMISSION_BYTES = 3 * 1024 * 1024
export const userImageInputSchema = z.strictObject({ dataUrl: z.string().max(Math.ceil(MAX_USER_IMAGE_BYTES / 3) * 4 + 64) })
export type UserImageInput = z.infer<typeof userImageInputSchema>
export interface StoredUserImage { dataUrl: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; byteLength: number; sha256: string }
function normalize(image: UserImageInput): StoredUserImage {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl)
  if (!match || match[2].length % 4 !== 0) throw new Error('userImageInvalid')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_USER_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw new Error('userImageInvalid')
  const type = match[1] as StoredUserImage['mediaType']
  if (!(type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255])) : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP')) throw new Error('userImageInvalid')
  return { dataUrl: image.dataUrl, mediaType: type, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
export const userImageInputsSchema = z.array(userImageInputSchema).max(MAX_USER_IMAGES).superRefine((images, context) => {
  for (const [index,image] of images.entries()) {
    try { normalize(image) } catch { context.addIssue({ code:'custom',message:'userImageInvalid',path:[index] }) }
  }
})
/** Called only after the host authenticates the submitting user. No URLs are fetched. */
export function normalizeUserImages(input: unknown): StoredUserImage[] {
  return input === undefined ? [] : userImageInputsSchema.parse(input).map(normalize)
}
const storedImageSchema = z.strictObject({ dataUrl:userImageInputSchema.shape.dataUrl,mediaType:z.enum(['image/png','image/jpeg','image/webp']),byteLength:z.number().int().positive().max(MAX_USER_IMAGE_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/) })
/** Read only from the stored host user_message event, never from peer/tool prose. */
export function userImageContent(input: unknown): Extract<UserModelMessage['content'], unknown[]> {
  if (input === undefined) return []
  const images = z.array(storedImageSchema).max(MAX_USER_IMAGES).parse(input)
  return images.map(stored => {
    const actual = normalize({dataUrl:stored.dataUrl})
    if (actual.sha256 !== stored.sha256 || actual.mediaType !== stored.mediaType || actual.byteLength !== stored.byteLength) throw new Error('storedUserImageInvalid')
    return { type:'file' as const,data:actual.dataUrl,mediaType:actual.mediaType }
  })
}
