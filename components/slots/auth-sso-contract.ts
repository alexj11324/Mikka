/** Company SSO on the sign-in page (#1608 P2), in every sign-in flow: Desktop and official-Web pass their own safe return as callbackURL, as Google and GitHub do. */
export type AuthSsoProps = {
  /** Where a successful SSO sign-in returns, as the other providers' callback. */
  callbackURL: string
  /** Another sign-in is in progress. */
  disabled: boolean
}
