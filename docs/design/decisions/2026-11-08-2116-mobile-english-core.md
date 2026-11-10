# English mobile core screens for App Store screenshots

- Date 2026-11-08
- Source Alex requested English screenshots of the updated iOS interface in the App Store release task, issue #1766.
- Rules R-42 and the existing mobile component ownership.

The mobile core uses the device language at app launch. English device settings
select English messages. Chinese language variants select the existing Chinese
catalog. Other device languages use the English core catalog.

Covered surfaces are the shared tabs, Bot list and its swipe actions, chat header and composer,
task list, task details, task conversation labels, document loading state and
date labels. Strings live in the shared `messages/en.json` and
`messages/zh-CN.json` catalogs, selected through `apps/mobile/lib/messages.ts`.

iOS declares English and Chinese bundle localizations so its locale selection
can reach both catalogs. This native configuration requires a compatible new
binary. Native English and Chinese language selection is checked on iOS during
release acceptance.

App Store screenshots use the updated interface and the dedicated Mikka Demo
workspace. Record the application revision, official mobile UI layer revision,
device, language and rendering environment with the captures.
