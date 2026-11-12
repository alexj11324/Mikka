import { createHmac, timingSafeEqual } from 'node:crypto'

type Coordinates = { installationId: string; linkId: string; teamId: string; slackUserId: string }
/** A product-tool JWT alone cannot request the native Slack transport's credential. */
export function slackGrantProof(auth: string, grant: Coordinates, secret = process.env.BETTER_AUTH_SECRET) {
  if (!secret || secret.length < 32) throw new Error('slackUnavailable')
  return createHmac('sha256', secret)
    .update(
      JSON.stringify([
        'mikka:slack:transport:v1',
        auth,
        grant.installationId,
        grant.linkId,
        grant.teamId,
        grant.slackUserId,
      ]),
    )
    .digest('base64url')
}
export function validSlackGrantProof(auth: string, grant: Coordinates, value: string | null) {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
  return timingSafeEqual(Buffer.from(slackGrantProof(auth, grant)), Buffer.from(value))
}
