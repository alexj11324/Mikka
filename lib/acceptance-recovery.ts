type AcceptanceRecovery = {
  embedded: boolean
  requestStorageAccess?: () => Promise<void>
  navigate: () => void
}

export async function recoverAcceptanceSession({ embedded, requestStorageAccess, navigate }: AcceptanceRecovery) {
  if (embedded) {
    if (!requestStorageAccess) throw new Error('Storage access is unavailable')
    // Safari requires this call during the click, before any asynchronous permission checks.
    await requestStorageAccess()
  }
  navigate()
}
