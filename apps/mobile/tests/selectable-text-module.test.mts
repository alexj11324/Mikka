import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The native edit-menu module (modules/selectable-text) cannot be compiled here; this pins that the names the JS side
// looks up are the ones the Swift module registers, and that autolinking finds it.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the module registers the name the chat looks up, with the props and events it passes', () => {
  const swift = read('modules/selectable-text/ios/SelectableTextModule.swift')
  const view = read('modules/selectable-text/ios/SelectableTextView.swift')
  const js = read('features/chat/components/native-selectable-text.ios.tsx')
  assert.match(swift, /Name\("MikkaSelectableText"\)/)
  assert.match(js, /requireOptionalNativeModule\('MikkaSelectableText'\)/)
  assert.match(js, /requireNativeView<NativeProps>\('MikkaSelectableText'\)/)
  for (const prop of ['text', 'color', 'fontSize', 'lineHeight', 'actionTitle']) assert.match(swift, new RegExp(`Prop\\("${prop}"\\)`))
  for (const event of ['onAddToChat', 'onSelectionChange']) {
    assert.match(swift, new RegExp(`"${event}"`))
    assert.match(view, new RegExp(`let ${event} = EventDispatcher\\(\\)`))
  }
  assert.match(view, /editMenuForTextIn/)
})

test('autolinking finds the module and its pod', () => {
  const config = JSON.parse(read('modules/selectable-text/expo-module.config.json'))
  assert.deepEqual(config.apple.modules, ['SelectableTextModule'])
  assert.match(read('modules/selectable-text/ios/MikkaSelectableText.podspec'), /dependency 'ExpoModulesCore'/)
})
