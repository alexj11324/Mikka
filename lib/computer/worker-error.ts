/** A cloud worker failure the route may log: a fixed code and the sandbox, never a provider message. */
export class CloudWorkerError extends Error {
  constructor(readonly code: 'worker_version_mismatch' | 'worker_not_registered' | 'worker_unconfigured' | 'machine_unavailable', readonly sandboxId?: string) {
    super(code)
    this.name = 'CloudWorkerError'
  }
}
