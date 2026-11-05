// Presentation only. Do not use this string match for provider fallback,
// credential health or automatic model selection: those require typed receipts.
const STREAM_STEP = /^Step "step\/\/@ai-sdk\/workflow@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?\/\/doStreamStep" failed after \d+ retries:\s*/i
const BALANCE = /^Insufficient Balance(?: \(request_id:\s*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\))?$/i

/** The observed provider refusal, alone or wrapped by the model streaming step. */
export function chatBalanceRefusal(error: string | null | undefined): boolean {
  if (!error) return false
  return BALANCE.test(error.trim().replace(STREAM_STEP, ''))
}
