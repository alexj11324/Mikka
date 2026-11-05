// Server tracing to PostHog (docs/operations/tracing.md). Node runtime only: the
// OpenTelemetry Node SDK and the pg instrumentation do not run on the edge.
// Keep the import inside this exact check, so the edge bundle drops it.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startTracing } = await import('./lib/tracing/node')
      startTracing()
    } catch (error) {
      // Tracing is diagnostics; the server starts without it.
      console.error('Tracing did not start', error instanceof Error ? error.name : 'unknown')
    }
  }
}
