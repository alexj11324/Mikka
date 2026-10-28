/** Existing vision-capable decision model and existing budgeted Gateway route. */
export const DECISION_MODEL = 'openai/gpt-6-luna-decisions'
export const DECISIONS_URL = 'https://ai-gateway.vercel.sh/v1/decisions'

export type DecisionQuestion =
  | { type: 'predicate'; name: string; instructions: string }
  | { type: 'choice'; name: string; instructions: string; choices: { value: string; description?: string }[] }
export type DecisionAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | { type: 'choice'; name: string; choice: string; confidence?: number; probabilities?: { value: string; probability: number }[] }
  | { type: 'refusal'; name: string }
export interface DecisionResponse { answers?: DecisionAnswer[] }
export interface DecisionImage { dataUrl: string; detail?: 'low' | 'high' | 'auto' | 'original' }
/** Bytes are observations, never a source of permission or proof of execution. */
export interface DecisionContext { text: string; images?: readonly DecisionImage[]; requiresVisual?: boolean }
export type DecisionInput = string | DecisionContext

/** Bounds/format checks protect transport and budgets, not business semantics. */
export function decisionRequestInput(input: DecisionInput) {
  if (typeof input === 'string') return input
  if (!input || typeof input.text !== 'string' || (input.images !== undefined && !Array.isArray(input.images))) throw Error('decisionInputInvalid')
  const images = input.images ?? []
  if (images.length > 8 || (input.requiresVisual && !images.length)) throw Error('decisionVisualEvidenceUnavailable')
  let total = 0
  const parts = images.map(image => {
    if (!image || typeof image.dataUrl !== 'string' || !['low','high','auto','original'].includes(image.detail ?? 'auto')) throw Error('decisionImageInvalid')
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl)
    if (!match || match[2].length % 4 !== 0 || match[2].length > 5_600_000) throw Error('decisionImageInvalid')
    total += match[2].length
    if (total > 11_200_000) throw Error('decisionImageBudgetExceeded')
    const prefix = atob(match[2].slice(0, 32))
    if (!(match[1] === 'png' ? prefix.startsWith('\x89PNG\r\n\x1a\n') : match[1] === 'jpeg' ? prefix.startsWith('\xff\xd8\xff') : prefix.startsWith('RIFF') && prefix.slice(8,12) === 'WEBP')) throw Error('decisionImageInvalid')
    return { type: 'input_image' as const, image_url: image.dataUrl, detail: image.detail ?? 'auto' }
  })
  return [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: input.text }, ...parts] }]
}

export function answersByName(body: DecisionResponse): Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>> {
  const answers = new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>()
  for (const answer of body.answers ?? []) if (answer.type !== 'refusal' && answer.name) answers.set(answer.name, answer)
  return answers
}
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
/** A malformed response is unavailable evidence; it is never a fabricated answer. */
export function validatedAnswers(body: unknown, questions: readonly DecisionQuestion[]) {
  if (!body || typeof body !== 'object' || !Array.isArray((body as DecisionResponse).answers)) return null
  const seen = new Set<string>(), valid: DecisionAnswer[] = []
  for (const raw of (body as DecisionResponse).answers!) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || seen.has(raw.name)) return null
    const question = questions.find(question => question.name === raw.name)
    if (!question) return null
    seen.add(raw.name)
    if (raw.type === 'refusal') { valid.push(raw); continue }
    if (raw.type !== question.type) return null
    if (raw.type === 'predicate') { if (!probability(raw.probability)) return null }
    else if (raw.type === 'choice' && question.type === 'choice') {
      const allowed = new Set(question.choices.map(choice => choice.value))
      if (!allowed.has(raw.choice) || (raw.confidence !== undefined && !probability(raw.confidence))) return null
      if (raw.probabilities !== undefined) {
        if (!Array.isArray(raw.probabilities) || new Set(raw.probabilities.map(p => p?.value)).size !== raw.probabilities.length || raw.probabilities.some(p => !p || !allowed.has(p.value) || !probability(p.probability))) return null
      }
    } else return null
    valid.push(raw)
  }
  return answersByName({ answers: valid })
}

/** Retained text-call interface for other owners; no change to their policy logic. */
export function decisionInput(state: Record<string, string>): string {
  return Object.entries(state).map(([key, value]) => key + ': ' + value).join('\n')
}
