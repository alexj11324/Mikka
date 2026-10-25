import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getStepMetadata } from 'workflow'
import type { ApprovalActionName } from '../composio-actions'
import { pool } from '../db'
import { getComposio } from '../composio'
import { composioCalendarProvider, type CalendarProvider } from './calendar-provider'
import { createCalendarOperations } from './calendar-service'

const testProvider = new AsyncLocalStorage<CalendarProvider>()
/** Test-only injection around the actual application entrypoints; not env-selected
 * HTTP forwarding, not a production route or a user-controlled provider selector.
 */
export function withCalendarTestProvider<T>(provider: CalendarProvider, work: () => T): T {
  if (process.env.NODE_ENV !== 'test' || process.env.OPERATION_DB_TESTS !== '1') throw new Error('test provider unavailable')
  return testProvider.run(provider, work)
}
export function approvedActionOperations(action: ApprovalActionName) {
  return createCalendarOperations(pool, testProvider.getStore() ?? composioCalendarProvider(getComposio(), action), action)
}
export function calendarOperations() { return approvedActionOperations('create_calendar_event') }
export function currentCalendarIntentKey() {
  // SDK stepId is stable when its attempt increases. No model argument or prompt key.
  return `workflow-step:${getStepMetadata().stepId}`
}
