import { routes } from '../generated/routes'
import { beginRequestTrace } from '../runtime/request-trace'
import { createApiHandler } from './application'

// Generated imports are lazy. The outer runtime initializes tracing before
// importing this module, so no business handler/pg loads before instrumentation.
export default createApiHandler(routes, beginRequestTrace)
