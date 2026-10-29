import { COORDINATOR_JUDGMENT_POLICY } from '../coordinator/judgment-policy'
import { PERSONAL_MESSAGE_INSTRUCTIONS } from '../personal-agent-message'
import { definitionInstructions, type DefinitionSnapshot } from './definition'

/** A frozen revision cannot opt out of the current mandatory host policy.
 * Keep its historical host text and digest untouched for replay/audit.
 */
export function executionHostInstructions(snapshot: DefinitionSnapshot): string {
  const host = snapshot.hostInstructions.includes(PERSONAL_MESSAGE_INSTRUCTIONS)
    ? snapshot.hostInstructions
    : `${snapshot.hostInstructions}\n\n${PERSONAL_MESSAGE_INSTRUCTIONS}`
  return host.includes(COORDINATOR_JUDGMENT_POLICY) ? host : `${COORDINATOR_JUDGMENT_POLICY}\n\n${host}`
}

export function executionInstructions(snapshot: DefinitionSnapshot): string {
  return definitionInstructions(executionHostInstructions(snapshot), snapshot.definition)
}
