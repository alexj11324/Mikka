import 'server-only'
import { ActionFailureError } from '@/lib/action-error'
import type { ProjectExecutionSnapshot } from './contracts'
import { assertFrozenProjectExecution, withProjectExecution, type ProjectExecutionInput } from './store'

/** Queue authorization is not permission to start after an administrator has
 * revoked a repository or environment. Hold the live policy lease until the
 * claim response is built, while preserving the originally frozen definition. */
export async function withRunProjectExecution<T>(input: ProjectExecutionInput, frozen: ProjectExecutionSnapshot | undefined, operation: () => Promise<T>) {
  return withProjectExecution(input, async admitted => {
    if (frozen) assertFrozenProjectExecution(frozen, admitted)
    else {
      // Legacy runs have no environment snapshot. They retain the original
      // checkout and cannot silently acquire a newly configured setup recipe.
      if (admitted.environment) throw new ActionFailureError('projectEnvironmentUnavailable')
      if (admitted.baseBranch !== input.baseBranch) throw new ActionFailureError('projectRepositoryDenied')
    }
    return operation()
  })
}
