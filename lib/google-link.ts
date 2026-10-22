export async function completeGoogleLink(
  userId: string,
  accounts: readonly { providerId: string }[],
  updateUser: (userId: string, data: { emailVerified: true }) => Promise<unknown>,
) {
  if (!accounts.some(account => account.providerId === 'google')) return false
  return Boolean(await updateUser(userId, { emailVerified: true }))
}
