import { startTracing } from '@/lib/tracing/node'

// The build's Node and Vercel entry wrappers load this module before dynamically
// importing the application, including Workflow handlers. A Nitro plugin alone
// is too late: static route/step imports can already have loaded pg by then.
// Keep the same best-effort diagnostics policy as instrumentation.ts.
try {
  startTracing()
} catch (error) {
  console.error('Tracing did not start', error instanceof Error ? error.name : 'unknown')
}
