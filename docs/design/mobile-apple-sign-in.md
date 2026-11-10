# Native Apple sign-in

Status is in review. The authorized scope adds native Sign in with Apple to the
existing Expo iOS app for App Store submission.

## What the person does

A new or returning person chooses Continue with Apple on sign-in, completes the
system authorization sheet, and enters the selected server's existing account
session. Canceling the sheet returns to idle sign-in. Deleting an Apple account
uses the existing account-deletion handoff and presents manual Apple authorization
revocation instructions after that handoff ends the session.

## Components and layout

`SignIn` keeps its existing provider group and scroll container. Apple's
`AppleAuthenticationButton` is the system-owned sign-in control, placed before
Google with the same 52-point height and 26-point radius. The system owns the
localized Apple label and logo. Light appearance uses the black button, dark
appearance uses the white button. The selected server must advertise Apple and
the native API must be available. The email separator includes the Apple method.

## Invariants and failure conditions

Tokens stay out of logs and persistent app storage. A fresh 256-bit random value
and the exact selected auth-server URL hash form the nonce. The app hashes that nonce for Apple. The receiving server checks its
own URL binding and the hashed nonce claim before Better Auth verifies the token.
The server checks issuer, audience, signature, expiration, nonce and verified email. Existing
verified-email linking and provider-subject ownership rules apply. A missing
token, missing nonce, failed secure-storage write or changed server slot prevents
authentication. Every saved server slot keeps its own Apple credential marker.
A late revocation result cannot end another slot's session.

## Acceptance matrix

| Axis | Required cases |
| --- | --- |
| Device | iPhone portrait at 320, 393 and 440 points. Tablet and landscape are disabled by app configuration. |
| Appearance | Light and dark, standard and largest accessibility text, VoiceOver navigation. |
| Sign-in state | Fresh cloud, upgraded saved cloud, configured community, unsupported server, loading, cancellation, native error, offline and rejected token. |
| Identity | First consent with share-email and hide-email, returning consent with no name, verified existing account and unverified email conflict. |
| Session | Restart, foreground after external revocation, active revocation notification, account switch during a pending check and account deletion handoff. |
| Keyboard | Email keyboard open and dismissed, provider actions and privacy link remain reachable by scrolling. |

## Done when

The focused server-handler and native-boundary tests, mobile type check and
repository CI pass on the submitted revision. Expo Web screenshots show the
preserved sign-in layout and account entries. A compatible EAS binary supplies
native Apple-button, authorization, Keychain persistence, revocation, VoiceOver
and Dynamic Type evidence. Expo Web cannot establish those native results.
