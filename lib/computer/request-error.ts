/** Shared between the browser request and the desktop main-owned transport. */
export class ComputerRequestError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}`) }
}
