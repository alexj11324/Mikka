import ExpoModulesCore
import UIKit

final class SelectableTextView: ExpoView, UITextViewDelegate {
  let onAddToChat = EventDispatcher()
  let onSelectionChange = EventDispatcher()

  var text = "" { didSet { render() } }
  var color: UIColor = .label { didSet { render() } }
  var fontSize: CGFloat = 16 { didSet { render() } }
  var lineHeight: CGFloat = 22 { didSet { render() } }
  var actionTitle = "添加到对话"

  private let textView = UITextView()
  private var selectedOnce = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []
    textView.delegate = self
    addSubview(textView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
  }

  /// The words as React Native draws them in the bubble: the system font at the chat's size, on a fixed line height.
  private func render() {
    let font = UIFont.systemFont(ofSize: fontSize)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    textView.attributedText = NSAttributedString(string: text, attributes: [
      .font: font,
      .foregroundColor: color,
      .paragraphStyle: paragraph,
      .baselineOffset: (lineHeight - font.lineHeight) / 4,
    ])
  }

  /// It opens with every word selected and the menu up, as the long press that opened it asked.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, !selectedOnce else { return }
    selectedOnce = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.textView.becomeFirstResponder()
      self.textView.selectedRange = NSRange(location: 0, length: (self.textView.text as NSString).length)
    }
  }

  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    let selected = (textView.text as NSString).substring(with: range)
    let add = UIAction(title: actionTitle, image: UIImage(systemName: "text.quote")) { [weak self] _ in
      self?.onAddToChat(["text": selected])
    }
    return UIMenu(children: [add] + suggestedActions)
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    let range = textView.selectedRange
    let selected = range.length > 0 ? (textView.text as NSString).substring(with: range) : ""
    onSelectionChange(["text": selected])
  }
}
