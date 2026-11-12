/** A single user's logical send has one row in this group, even when the acknowledgement is lost. */
export async function groupSubmissionMessageId(ownerId: string, groupId: string, requestId: string) {
  const identity = new TextEncoder().encode(JSON.stringify(['group-message', ownerId, groupId, requestId]))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', identity)).slice(0, 16)
  digest[6] = (digest[6] & 15) | 128
  digest[8] = (digest[8] & 63) | 128
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
