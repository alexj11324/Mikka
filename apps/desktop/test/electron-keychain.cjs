// Test launcher only. Playwright's unpackaged Electron loader normally selects
// a mock/basic keychain, which cannot verify the application's encrypted vault.
// This file is loaded after that loader, before the actual application entry.
const { app } = require('electron')

if (app.isReady()) throw new Error('NATIVE_ACCEPTANCE_KEYCHAIN_BOOTSTRAP_TOO_LATE')
app.commandLine.removeSwitch('use-mock-keychain')
app.commandLine.removeSwitch('password-store')
if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'gnome-libsecret')

