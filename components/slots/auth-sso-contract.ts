/** Company SSO on the sign-in page (#1608 P2): plain web sign-in only, not the desktop or Web-connection flows. */
export type AuthSsoProps = {
  /** Where a successful SSO sign-in returns, as the other providers' callback. */
  callbackURL: string
  /** Another sign-in is in progress. */
  disabled: boolean
}
