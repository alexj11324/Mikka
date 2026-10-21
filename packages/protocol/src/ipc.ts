// IPC channel names shared by the preload script and Electron main.
// Kept free of runtime dependencies so the sandboxed preload stays small.
export const IPC = {
  settingsGetAll: "orvilo:settings:get-all",
  settingsSet: "orvilo:settings:set",
  quotaGet: "orvilo:quota:get",
  authGetState: "orvilo:auth:get-state",
  authSignIn: "orvilo:auth:sign-in",
  authDevSignIn: "orvilo:auth:dev-sign-in",
  authSignOut: "orvilo:auth:sign-out",
  authGetToken: "orvilo:auth:get-token",
  authLinkAccount: "orvilo:auth:link-account",
  previewHtml: "orvilo:preview:html",
  notificationsShow: "orvilo:notifications:show",
  notificationsSetBadge: "orvilo:notifications:set-badge",
  /** The renderer subscribed; main hands over a click it stored. */
  notificationsConsumePendingClick:
    "orvilo:notifications:consume-pending-click",
  /** main -> renderer push of a click's in-app href. */
  notificationsClicked: "orvilo:notifications:clicked",
  deviceStatus: "orvilo:device:status",
  deviceLink: "orvilo:device:link",
  devicePickRepo: "orvilo:device:pick-repo",
  /** main -> renderer push of AuthState. */
  authChanged: "orvilo:auth:changed",
} as const
