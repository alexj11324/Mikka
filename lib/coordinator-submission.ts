// Sending a message to the Coordinator through POST /api/coordinator/messages
// with an idempotency key (submissionId).
//
// A logical submission is one account's trimmed text and questionId. Until it
// settles it keeps one id and one frozen body: trying again after a timeout, a
// lost response, a 5xx or a sign-in as the same account resends exactly that
// body with that id, so the server stores it once. Sending other text (an
// edited draft, another answer) is a separate submission with its own id and
// never replaces one that is still unsettled. Once a submission is accepted or
// rejected, the same text sent again is a new submission with a new id. After a
// 409 the body is closed for good: sending it again makes no request.
// Nothing here retries on its own; every request follows a person's action.
// Ids live only in this submitter's memory: after a reload or once the
// composer unmounts, a resend is a new submission and may be stored twice.

import { withBasePath } from '@/lib/base-path'

export const MESSAGE_MAX_LENGTH = 10_000
const REQUEST_TIMEOUT_MS = 20_000

export type Submission = { owner: string; submissionId: string; text: string; questionId: string | null }

export type SubmitOutcome =
  // Stored. Not an approval of anything the message asks for.
  | { kind: 'accepted'; enabled: boolean; sourceEventId: string | null; replayed: boolean }
  // The result is unknown (timeout, network error, 5xx). Sending again reuses the id.
  | { kind: 'uncertain' }
  // Signed out. Sending again as the same account reuses the id; another account starts anew.
  | { kind: 'authRequired' }
  // The server holds a different body under this id. Terminal: never resent, never given a new id.
  | { kind: 'conflict' }
  | { kind: 'rejected'; error: 'messageRequired' | 'originRejected' | 'failed' }
  // Another submission of this composer is still in flight.
  | { kind: 'busy' }

type Fetch = (input: string, init: RequestInit) => Promise<Response>
type Unsettled = { submission: Submission; state: 'uncertain' | 'authRequired' | 'conflict' }

export async function readOutcome(response: Response): Promise<SubmitOutcome> {
  const body: Record<string, unknown> = await response.json().catch(() => ({}))
  if (response.status === 202 && body.queued === true) return {
    kind: 'accepted',
    enabled: body.enabled !== false,
    sourceEventId: typeof body.sourceEventId === 'string' ? body.sourceEventId : null,
    replayed: body.replayed === true,
  }
  if (response.status >= 500 || response.status === 202) return { kind: 'uncertain' }
  if (response.status === 401) return { kind: 'authRequired' }
  if (response.status === 409) return { kind: 'conflict' }
  if (response.status === 403) return { kind: 'rejected', error: 'originRejected' }
  if (response.status === 400) return { kind: 'rejected', error: 'messageRequired' }
  return { kind: 'rejected', error: 'failed' }
}

/**
 * `currentOwner` reads the account the request's cookie belongs to right
 * before each send (null when signed out), so a submission is never resent
 * under another account, even after a switch in another tab.
 */
export function createCoordinatorSubmitter({ currentOwner, fetch = (input, init) => globalThis.fetch(input, init), newId = () => crypto.randomUUID() }: { currentOwner: () => Promise<string | null>; fetch?: Fetch; newId?: () => string }) {
  // Submissions that have not settled, by account and body.
  const unsettled = new Map<string, Unsettled>()
  let inFlight: { text: string; questionId: string | null; result: Promise<SubmitOutcome> } | null = null
  const keyOf = (owner: string, text: string, questionId: string | null) => JSON.stringify([owner, text, questionId])

  async function post(submission: Submission): Promise<SubmitOutcome> {
    try {
      const response = await fetch(withBasePath('/api/coordinator/messages'), {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: submission.text, submissionId: submission.submissionId, ...(submission.questionId ? { questionId: submission.questionId } : {}) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return await readOutcome(response)
    } catch {
      return { kind: 'uncertain' }
    }
  }

  async function send(text: string, questionId: string | null): Promise<SubmitOutcome> {
    let owner: string | null
    try { owner = await currentOwner() } catch { return { kind: 'rejected', error: 'failed' } }
    if (!owner) return { kind: 'authRequired' }
    const key = keyOf(owner, text, questionId)
    const held = unsettled.get(key)
    if (held?.state === 'conflict') return { kind: 'conflict' }
    const submission = held?.submission ?? { owner, submissionId: newId(), text, questionId }
    const outcome = await post(submission)
    if (outcome.kind === 'uncertain' || outcome.kind === 'authRequired' || outcome.kind === 'conflict') unsettled.set(key, { submission, state: outcome.kind })
    else unsettled.delete(key)
    return outcome
  }

  return {
    async submit(rawText: string, questionId?: string): Promise<SubmitOutcome> {
      const text = rawText.trim()
      if (!text || text.length > MESSAGE_MAX_LENGTH) return { kind: 'rejected', error: 'messageRequired' }
      const question = questionId ?? null
      // A second click on the same body joins the request already out.
      if (inFlight) return inFlight.text === text && inFlight.questionId === question ? inFlight.result : { kind: 'busy' }
      const current = { text, questionId: question, result: send(text, question) }
      inFlight = current
      try {
        return await current.result
      } finally {
        if (inFlight === current) inFlight = null
      }
    },
    /** The unsettled submission for this account and body, if any. */
    held: (owner: string, text: string, questionId: string | null = null) => unsettled.get(keyOf(owner, text, questionId)),
  }
}
