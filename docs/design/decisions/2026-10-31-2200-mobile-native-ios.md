# The iOS app uses the system's own controls

- Date: 2026-10-31
- Source: Alex, in the mobile session, on build 4: 「按钮、输入框之类的都不是原生的，也不支持手势。左侧的抽屉感觉就他妈像假的」, 「目前不支持上传附件，这个也不对吧」, and 「有原生能力的要用原生能力」 with the `ios-design` skill (uizze.sh)
- Rule: —
- Replaces: the custom floating header buttons (mobile.md, Figma 268:4750 frames 01–07) and 「the composer has no 「+」 yet」 in mobile.md

Where iOS has a control for the job, the app uses it instead of drawing one:

- The top bar on every screen is the system navigation bar: transparent over
  the content with the system's scroll-edge effect, its buttons and the 线程
  filter menu UIKit bar items (Liquid Glass on iOS 26), the system back
  chevron and swipe back on pushed pages, and 设置 a system modal sheet.
- The composer's 「+」 is a SwiftUI menu (拍照 · 照片 · 文件) on a glass
  button. Photos come from the system photo picker or camera; files from the
  system document picker. The field is multi-line, rides on the keyboard and
  is dismissed by dragging the chat down.
- Floating round buttons and the composer field are Liquid Glass on iOS 26.

iOS has no system drawer, so the drawer stays the app's own, but it now
follows the finger: a swipe right on a drawer screen opens it, a swipe left or
a tap closes it, and letting go settles with a spring that takes the swipe's
speed, on the UI thread, with a light haptic.

Attachments: up to two photos per message (JPEG, scaled to fit the server's
1 MB per photo), and text files, which travel in the message as their
contents, as on the web. A sent photo shows above the person's bubble.
现状（非决定）：PDFs and other files are refused; the server cannot read them
yet.

The `ios-design` skill is vendored in `.claude/skills/ios-design/` and is the
checklist for iOS work. These native modules need a new TestFlight build.

Later the same evening, on 「你这个抽屉不像原生呀」: the drawer's icons are SF
Symbols; its top is a Liquid Glass search field and a compose button (新建),
which replace the 「Mikka」 title and the blue 「新建」 pill; its last row is
the person's avatar and name, opening 设置; the pushed screen dims as the
drawer opens. Under the bars, content blurs (top, the system's scroll-edge
effect) and fades (behind the composer), and the bot's name sits in a glass
capsule.
