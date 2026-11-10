// IPC channel names shared by the preload script and Electron main.
// Kept free of runtime dependencies so the sandboxed preload stays small.
export const IPC = {
  appOpenExternal: "mikka:app:open-external",
  appPrepareAuth: "mikka:app:prepare-auth",
  appClaudeCallback: "mikka:app:claude-callback",
  /** A one-shot loopback for a link finished in the system browser; also main -> renderer with its result. */
  appPrepareReturn: "mikka:app:prepare-return",
  appReturned: "mikka:app:returned",
  /** The downloaded update's version, or null; also main -> renderer once it downloads. */
  appUpdateReady: "mikka:app:update-ready",
  appInstallUpdate: "mikka:app:install-update",
  /** The page saw /api/version require a newer desktop; main verifies and runs the update gate. */
  appRequireUpdate: "mikka:app:require-update",
  settingsGetAll: "mikka:settings:get-all",
  settingsSet: "mikka:settings:set",
  quotaGet: "mikka:quota:get",
  authGetState: "mikka:auth:get-state",
  authSignIn: "mikka:auth:sign-in",
  authDevSignIn: "mikka:auth:dev-sign-in",
  authSignOut: "mikka:auth:sign-out",
  authGetToken: "mikka:auth:get-token",
  authLinkAccount: "mikka:auth:link-account",
  previewHtml: "mikka:preview:html",
  notificationsShow: "mikka:notifications:show",
  notificationsSetBadge: "mikka:notifications:set-badge",
  /** The renderer subscribed; main hands over a click it stored. */
  notificationsConsumePendingClick:
    "mikka:notifications:consume-pending-click",
  /** main -> renderer push of a click's in-app href. */
  notificationsClicked: "mikka:notifications:clicked",
  sshChanged: "mikka:ssh:changed",
  sshHosts: "mikka:ssh:hosts",
  sshBegin: "mikka:ssh:begin",
  sshCancel: "mikka:ssh:cancel",
  sshAccept: "mikka:ssh:accept",
  sshState: "mikka:ssh:state",
  sshLocal: "mikka:ssh:local",
  sshRestartLocal: "mikka:ssh:restart-local",
  /** Once per launch: make this computer a device (install, or restart then install). */
  sshAutoLocal: "mikka:ssh:auto-local",
  deviceStatus: "mikka:device:status",
  deviceLink: "mikka:device:link",
  devicePickRepo: "mikka:device:pick-repo",
  /** Local computer use on this Mac: read-only doctor, and the person's grant click. */
  deviceComputerPermissions: "mikka:device:computer-permissions",
  deviceComputerPermissionsGrant: "mikka:device:computer-permissions-grant",
  /** main -> renderer push of AuthState. */
  authChanged: "mikka:auth:changed",
} as const
export { BUNDLED_IPC } from './bundled'
