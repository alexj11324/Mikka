// IPC channel names shared by the preload script and Electron main.
// Kept free of runtime dependencies so the sandboxed preload stays small.
export const IPC = {
  appOpenExternal: "mikka:app:open-external",
  appPrepareAuth: "mikka:app:prepare-auth",
  appClaudeCallback: "mikka:app:claude-callback",
  /** The downloaded update's version, or null; also main -> renderer once it downloads. */
  appUpdateReady: "mikka:app:update-ready",
  appInstallUpdate: "mikka:app:install-update",
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
  deviceStatus: "mikka:device:status",
  deviceLink: "mikka:device:link",
  devicePickRepo: "mikka:device:pick-repo",
  /** main -> renderer push of AuthState. */
  authChanged: "mikka:auth:changed",
} as const
