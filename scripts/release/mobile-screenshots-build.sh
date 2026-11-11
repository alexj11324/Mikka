#!/usr/bin/env bash
set -euo pipefail
umask 077

test "$#" -le 1
case "${1:-}" in
  ''|--preflight-only) ;;
  *) exit 2 ;;
esac

mkdir -p "$RUNNER_TEMP/mikka-screenshots-private"

run_build_phase() {
  local phase="$1" start elapsed status
  shift
  case "$phase" in
    xcode-select|expo-prebuild|expo-update-config|cocoapods-install|xcodebuild) ;;
    *) return 2 ;;
  esac
  start=$(date +%s)
  printf 'native-screenshot-phase {"phase":"%s","event":"start","at":"%s","elapsedMs":0}\n' "$phase" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if "$@" > "$RUNNER_TEMP/mikka-screenshots-private/$phase.log" 2>&1; then
    elapsed=$(( ($(date +%s) - start) * 1000 ))
    printf 'native-screenshot-phase {"phase":"%s","event":"success","at":"%s","elapsedMs":%d}\n' "$phase" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed"
  else
    status=$?
    elapsed=$(( ($(date +%s) - start) * 1000 ))
    printf 'native-screenshot-phase {"phase":"%s","event":"failure","at":"%s","elapsedMs":%d,"errorName":"BuildCommandError","errorCode":"BUILD_CHILD_EXIT","exitCode":%d}\n' "$phase" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed" "$status"
    return "$status"
  fi
}

select_xcode() {
  xcode=$(find /Applications -maxdepth 1 -name 'Xcode_26*.app' | grep -vi beta | sort -V | tail -1)
  test -n "$xcode" && sudo xcode-select -s "$xcode"
}
run_build_phase xcode-select select_xcode

# A fresh simulator owns its locale, data and keychain for this run only.
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { screenshotPhase } from './scripts/release/mobile-screenshots.mjs'
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const udid = await screenshotPhase('simulator-create', () => {
    const types = JSON.parse(simctl('list', 'devicetypes', '--json')).devicetypes
    const type = types.find(item => item.name === 'iPhone 17 Pro')
    const runtime = JSON.parse(simctl('list', 'runtimes', '--json')).runtimes
      .filter(item => item.isAvailable && /^iOS 26/.test(item.name)).at(-1)
    if (!type || !runtime) throw Error('iPhone17ProAndIOS26Required')
    const udid = simctl('create', `Mikka App Store ${process.env.GITHUB_RUN_ID}`, type.identifier, runtime.identifier).trim()
    appendFileSync(process.env.GITHUB_ENV, `SCREENSHOT_UDID=${udid}\n`)
    writeFileSync(`${process.env.RUNNER_TEMP}/mikka-screenshots-private/device.json`, JSON.stringify({ udid, device: type.name, runtime: runtime.name }))
    return udid
  })
  await screenshotPhase('simulator-boot-initial', () => {
    simctl('boot', udid)
    simctl('bootstatus', udid, '-b')
  })
  await screenshotPhase('simulator-system-locale', () => {
    simctl('spawn', udid, 'defaults', 'write', 'NSGlobalDomain', 'AppleLanguages', '-array', 'en')
    simctl('spawn', udid, 'defaults', 'write', 'NSGlobalDomain', 'AppleLocale', '-string', 'en_US')
  })
  await screenshotPhase('simulator-boot-localized', () => {
    simctl('shutdown', udid)
    simctl('boot', udid)
    simctl('bootstatus', udid, '-b')
  })
} catch { process.exitCode = 1 }
JS

node scripts/release/mobile-screenshots.mjs driver-preflight

if [ "${1:-}" = --preflight-only ]; then exit 0; fi

cd apps/mobile
run_build_phase expo-prebuild pnpm exec expo prebuild --platform ios --no-install
# Keep the embedded bundle tied to GITHUB_SHA, even when a production OTA exists.
disable_updates() {
  expo_plist=$(find ios -name Expo.plist -print -quit)
  test -n "$expo_plist" && /usr/libexec/PlistBuddy -c 'Set :EXUpdatesEnabled false' "$expo_plist"
}
install_pods() { (cd ios && pod install); }
run_build_phase expo-update-config disable_updates
run_build_phase cocoapods-install install_pods
run_build_phase xcodebuild xcodebuild -workspace ios/Mikka.xcworkspace -scheme Mikka -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$RUNNER_TEMP/mikka-screenshots-private/build" \
  CODE_SIGNING_ALLOWED=NO
