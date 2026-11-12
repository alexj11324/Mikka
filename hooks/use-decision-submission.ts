'use client'

import { useReducer, useState } from 'react'
import { createDecisionSubmission } from './decision-submission'

export type { DecisionReceipt, DecisionState } from './decision-submission'

export function useDecisionSubmission() {
  const [, update] = useReducer((value: number) => value + 1, 0)
  const [submission] = useState(() => createDecisionSubmission(update))
  return submission
}
