import type { FactoryBinding } from './contract'
import { request } from './browser-request'

export type ReviewChangeTarget = { label: string; binding: FactoryBinding }

export async function sendReviewChange(binding: FactoryBinding, eventId: string, note: string, expectedOwnerId?: string) {
  return request(`/api/factory/tasks/${binding.taskId}/approval`, {
    operation: 'reject', input: { binding, candidateId: binding.candidateId, eventId, note: note.trim() },
  }, expectedOwnerId ? { 'x-mikka-expected-owner': expectedOwnerId } : undefined)
}
