/** Existing public deployment override, read when a client builds its commands. */
export function daemonPackageName() {
  return process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka'
}

/** Where the packaged desktop app is published; it bundles the daemon, so it is also a way to add a device. */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/alexj11324/Mikka/releases/latest'
