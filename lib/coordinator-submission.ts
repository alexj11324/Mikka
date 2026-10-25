// Sending a message to the Coordinator through POST /api/coordinator/messages
// with an idempotency key (submissionId).
//
// One logical submission keeps one id and one body (trimmed text and
// questionId) until it settles. Trying again after a timeout, a lost response,
// a 5xx or a sign-in on the same account resends exactly that body with that
// id, so the server stores it once. Anything the person starts anew — after an
// accepted send, after a rejection, or with different text — gets a new id.
// Nothing here retries on its own; every request follows a person's action.

import { withBasePath } from '@/lib/base-path'

export const MESSAGE_MAX_LENGTH = 10_000
const REQUEST_TIMEOUT_MS = 20_000

export type PendingSubmission = { owner: string; submissionId: string; text: string; questionId: string | null }

export type SubmitOutcome =
  // Stored. Not an approval of anything the message asks for.
  | { kind: 'accepted'; enabled: boolean; sourceEventId: string | null; replayed: boolean }
  // The result is unknown (timeout, network error, 5xx). Sending again reuses the id.
  | { kind: 'uncertain' }
  // Signed out. Sending again as the same account reuses the id; another account starts anew.
  | { kind: 'authRequired' }
  // The server holds a different body under this id. Stop; never retry under a new id.
  | { kind: 'conflict' }
  | { kind: 'rejected'; error: 'messageRequired' | 'originRejected' | 'failed' }
  // Another submission of this composer is still in flight.
  | { kind: 'busy' }

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export function nextSubmission(pending: PendingSubmission | null, owner: string, text: string, questionId: string | null, newId: () => string): PendingSubmission {
  if (pending && pending.owner === owner && pending.text === text && pending.questionId === questionId) return pending
  return { owner, submissionId: newId(), text, questionId }
}

// Whether the submission stays pending, so that the next send reuses its id.
export function keepsPending(outcome: SubmitOutcome) {
  return outcome.kind === 'uncertain' || outcome.kind === 'authRequired'
}

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

export function createCoordinatorSubmitter({ fetch = (input, init) => globalThis.fetch(input, init), newId = () => crypto.randomUUID() }: { fetch?: Fetch; newId?: () => string } = {}) {
  let pending: PendingSubmission | null = null
  let inFlight: { submission: PendingSubmission; result: Promise<SubmitOutcome> } | null = null

  async function post(submission: PendingSubmission): Promise<SubmitOutcome> {
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

  return {
    async submit(owner: string, rawText: string, questionId?: string): Promise<SubmitOutcome> {
      const text = rawText.trim()
      if (!text || text.length > MESSAGE_MAX_LENGTH) return { kind: 'rejected', error: 'messageRequired' }
      const submission = nextSubmission(pending, owner, text, questionId ?? null, newId)
      // A second click on the same submission joins the request already out.
      if (inFlight) return inFlight.submission === submission ? inFlight.result : { kind: 'busy' }
      pending = submission
      const result = post(submission)
      inFlight = { submission, result }
      try {
        const outcome = await result
        if (pending === submission && !keepsPending(outcome)) pending = null
        return outcome
      } finally {
        inFlight = null
      }
    },
    pending: () => pending,
  }
}
