import type { attentionMatters } from '@/lib/db/schema'

/**
 * Called once each time the Coordinator decides to tell the person about a
 * matter (record_attention notify, or a reply that told them). The message
 * itself is the Coordinator's reply in its own chat; this is where the mobile
 * client's push will go once it exists (R-20: "pushed on mobile"). A
 * verification code (`assessment.verificationCode`) is for the app chat only
 * and must never leave it, so a push for one should carry no code. Never throws.
 */
export async function onPersonTold(_matter: typeof attentionMatters.$inferSelect): Promise<void> {
  // No mobile client yet: nothing to push.
}
