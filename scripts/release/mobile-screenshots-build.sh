#!/usr/bin/env bash
set -euo pipefail
umask 077

xcode=$(find /Applications -maxdepth 1 -name 'Xcode_26*.app' | grep -vi beta | sort -V | tail -1)
test -n "$xcode"
sudo xcode-select -s "$xcode"
mkdir -p "$RUNNER_TEMP/mikka-screenshots-private"

# A fresh simulator owns its locale, data and keychain for this run only.
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' })
const types = JSON.parse(simctl('list', 'devicetypes', '--json')).devicetypes
const type = types.find(item => item.name === 'iPhone 17 Pro')
const runtime = JSON.parse(simctl('list', 'runtimes', '--json')).runtimes
  .filter(item => item.isAvailable && /^iOS 26/.test(item.name)).at(-1)
if (!type || !runtime) throw Error('iPhone17ProAndIOS26Required')
const udid = simctl('create', `Mikka App Store ${process.env.GITHUB_RUN_ID}`, type.identifier, runtime.identifier).trim()
appendFileSync(process.env.GITHUB_ENV, `SCREENSHOT_UDID=${udid}\n`)
writeFileSync(`${process.env.RUNNER_TEMP}/mikka-screenshots-private/device.json`, JSON.stringify({ udid, device: type.name, runtime: runtime.name }))
simctl('boot', udid)
simctl('bootstatus', udid, '-b')
simctl('spawn', udid, 'defaults', 'write', 'NSGlobalDomain', 'AppleLanguages', '-array', 'en')
simctl('spawn', udid, 'defaults', 'write', 'NSGlobalDomain', 'AppleLocale', '-string', 'en_US')
simctl('shutdown', udid)
simctl('boot', udid)
simctl('bootstatus', udid, '-b')
JS

cd apps/mobile
pnpm exec expo prebuild --platform ios --no-install > "$RUNNER_TEMP/mikka-screenshots-private/prebuild.log" 2>&1
# Keep the embedded bundle tied to GITHUB_SHA, even when a production OTA exists.
expo_plist=$(find ios -name Expo.plist -print -quit)
test -n "$expo_plist"
/usr/libexec/PlistBuddy -c 'Set :EXUpdatesEnabled false' "$expo_plist"
(cd ios && pod install) > "$RUNNER_TEMP/mikka-screenshots-private/pods.log" 2>&1
xcodebuild -workspace ios/Mikka.xcworkspace -scheme Mikka -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$RUNNER_TEMP/mikka-screenshots-private/build" \
  CODE_SIGNING_ALLOWED=NO > "$RUNNER_TEMP/mikka-screenshots-private/build.log" 2>&1
