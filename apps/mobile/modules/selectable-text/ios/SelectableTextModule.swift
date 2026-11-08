import ExpoModulesCore
import UIKit

/// A chat message's words, selectable in place with the system handles, whose edit menu leads with 添加到对话
/// (Alex 2026-11-08, as Codex adds a selection to the conversation). React Native's Text and TextInput cannot add an
/// item to the system edit menu, so this is a read-only UITextView whose delegate builds the menu.
public final class SelectableTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MikkaSelectableText")

    View(SelectableTextView.self) {
      Events("onAddToChat", "onSelectionChange")

      Prop("text") { (view, text: String) in
        view.text = text
      }
      Prop("color") { (view, color: UIColor?) in
        view.color = color ?? .label
      }
      Prop("fontSize") { (view, size: Double?) in
        view.fontSize = CGFloat(size ?? 16)
      }
      Prop("lineHeight") { (view, height: Double?) in
        view.lineHeight = CGFloat(height ?? 22)
      }
      Prop("actionTitle") { (view, title: String?) in
        view.actionTitle = title ?? "添加到对话"
      }
    }
  }
}
