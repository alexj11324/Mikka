import type { attentionMatters } from '@/lib/db/schema'

/**
 * Called once each time the Coordinator decides to tell the person about a
 * matter (record_attention notify, or a reply that told them). The message
 * itself is the Coordinator's reply in its own chat. Phones get that reply
 * from the turn itself (workflows/coordinator/workflow.ts → lib/mobile-push.ts,
 * R-20 "pushed on mobile"), so nothing is pushed here. A verification code
 * (`assessment.verificationCode`) never leaves the app chat: that push says
 * only that a code came. Never throws.
 */
export async function onPersonTold(_matter: typeof attentionMatters.$inferSelect): Promise<void> {
  // No mobile client yet: nothing to push.
}
