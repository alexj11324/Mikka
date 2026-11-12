import { setTimeout as delay } from 'node:timers/promises'

// GitHub can acknowledge creation before the new ref is visible on a read.
export async function verifyCreatedRef(readRef, expectedSha, wait = delay) {
  for (const pause of [500, 1500, 3500, 8000, 16000, 32000]) {
    const ref = await readRef(true)
    if (ref !== null) {
      if (ref.object?.sha !== expectedSha) throw new Error('EVIDENCE_PUBLICATION_MISMATCH')
      return
    }
    await wait(pause)
  }
  const ref = await readRef(false)
  if (ref?.object?.sha !== expectedSha) throw new Error('EVIDENCE_PUBLICATION_MISMATCH')
}
