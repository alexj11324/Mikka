/** A workspace rule refused the request; `code` names it for the action's error message. No server imports. */
export class WorkspaceError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'WorkspaceError'
  }
}
