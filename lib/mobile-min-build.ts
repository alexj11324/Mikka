/**
 * The oldest iOS build (CFBundleVersion) that may open Mikka. A phone on an
 * older build sees 「请更新到最新版」 at launch, with no way past it, and
 * `MOBILE_UPDATE_URL` to get the new one. Raise it in the same pull request
 * that ships a native change older builds cannot run (one an OTA update cannot
 * bring); 0 lets every build in.
 */
export const MIN_MOBILE_BUILD = 0

/** Where 更新 takes the phone: the app in TestFlight (App Store Connect app 6829300983, apps/mobile/eas.json). */
export const MOBILE_UPDATE_URL = 'itms-beta://beta.itunes.apple.com/v1/app/6829300983'
