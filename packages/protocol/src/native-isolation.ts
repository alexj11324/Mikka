/** The daemon advertises this only after its real Linux tool-isolation probe.
 * It is a transport capability, never a member permission or credential grant. */
export const NATIVE_CREDENTIAL_ISOLATION_HEADER = 'x-mikka-native-credential-isolation'
export const NATIVE_CREDENTIAL_ISOLATION_VERSION = 'tools_v1'

/** Direct native model authentication stays in the trusted CLI controller;
 * model-directed commands/files cannot access that controller's credentials. */
export type NativeCredentialIsolation = typeof NATIVE_CREDENTIAL_ISOLATION_VERSION
