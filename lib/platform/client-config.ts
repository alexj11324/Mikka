/** Existing public deployment override, read when a client builds its commands. */
export function daemonPackageName() {
  return process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka'
}
