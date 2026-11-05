// Test-only runtime diagnosis: no app code, sessions or network requests.
const { app, BrowserWindow } = require('electron')

if (!process.env.MIKKA_NATIVE_PREFLIGHT_PROFILE) throw new Error('NATIVE_PREFLIGHT_PROFILE_REQUIRED')
app.setPath('userData', process.env.MIKKA_NATIVE_PREFLIGHT_PROFILE)
app.enableSandbox()
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL('data:text/html,<title>Native runtime check</title>')
  console.log('MIKKA_NATIVE_RUNTIME_READY')
  app.quit()
}).catch(error => {
  console.error(error instanceof Error ? error.message : 'NATIVE_RUNTIME_FAILED')
  app.exit(1)
})
