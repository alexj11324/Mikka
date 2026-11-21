/** The public server only renders account, consent and handoff documents.
 * Routes reads the marker supplied by serverPageResponse before entering a
 * workspace. An unmarked document from this distribution is a packaging error. */
export async function loadWorkspace(): Promise<never> {
  throw new Error('SERVER_DOCUMENT_CANNOT_LOAD_WORKSPACE')
}

export function readLoadedWorkspace() { return undefined }
export async function preloadWorkspace() {}
