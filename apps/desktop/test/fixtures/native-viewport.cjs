// Credential-free real Electron rendering fixture for the acceptance viewport.
const { app, BrowserWindow } = require('electron')

if (!process.env.MIKKA_VIEWPORT_PROFILE) throw new Error('NATIVE_VIEWPORT_PROFILE_REQUIRED')
app.setPath('userData', process.env.MIKKA_VIEWPORT_PROFILE)
app.enableSandbox()
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 600, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(255,255,255)}
    #edge{position:fixed;right:0;bottom:0;width:2px;height:2px;background:rgb(0,0,255)}
    #edge:after{content:"";position:absolute;right:0;bottom:0;width:1px;height:1px;background:rgb(255,0,0)}
    button{position:fixed;right:10px;bottom:10px;width:100px;height:40px}
    #workspace{left:10px;top:10px;right:auto;bottom:auto}
    </style><div id="edge"></div><button onclick="document.title='clicked'">Edge click</button>
    <button id="workspace" role="menuitem" onclick="document.documentElement.dataset.switchRequested='true'">Switch workspace</button>`))
})
