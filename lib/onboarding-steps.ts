/**
 * The first-run guide's four steps, as Capy's (decision 2026-11-15-1900,
 * docs/design/onboarding.md): 工作区, 模型, 推荐, 套餐. No server imports, so the
 * guide and its tests share the rules.
 */
export const ONBOARDING_STEPS = ['workspace', 'model', 'recommended', 'plan'] as const
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]
export type OnboardingStepStatus = 'done' | 'skipped'
export type OnboardingProgress = { step: number; status: Record<number, OnboardingStepStatus> }

const last = ONBOARDING_STEPS.length - 1

/** A stored or posted place, reduced to steps that exist; anything else reads as the start. */
export function normalizeProgress(value: unknown): OnboardingProgress {
  const raw = value && typeof value === 'object' ? value as { step?: unknown; status?: unknown } : {}
  const step = typeof raw.step === 'number' && Number.isInteger(raw.step) ? Math.min(Math.max(raw.step, 0), last) : 0
  const status: Record<number, OnboardingStepStatus> = {}
  if (raw.status && typeof raw.status === 'object')
    for (const [key, item] of Object.entries(raw.status as Record<string, unknown>)) {
      const index = Number(key)
      if (Number.isInteger(index) && index >= 0 && index <= last && (item === 'done' || item === 'skipped')) status[index] = item
    }
  return { step, status }
}

/**
 * Where the guide opens. Someone who joined another person's team workspace
 * starts at 模型: the workspace is not theirs to name (Capy's invitee path).
 */
export function startingProgress(saved: OnboardingProgress | null, invitee: boolean): OnboardingProgress {
  if (saved) return invitee && saved.step === 0 ? { step: 1, status: { ...saved.status, 0: 'done' } } : saved
  return invitee ? { step: 1, status: { 0: 'done' } } : { step: 0, status: {} }
}
