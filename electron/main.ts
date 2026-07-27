import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron'
import type { Event } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createUsageTracker, UsageRange, UsageSummary } from './usageTracker'
import { getConfigPath, loadConfig, saveConfig, UsageConfig, WebDavConfig } from './configStore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST
const isDev = Boolean(VITE_DEV_SERVER_URL)

let win: BrowserWindow | null
let usageTracker: Awaited<ReturnType<typeof createUsageTracker>> | null = null
let usageConfig: UsageConfig | null = null
let syncTimer: NodeJS.Timeout | null = null
let dailyTimer: NodeJS.Timeout | null = null
let tray: Tray | null = null
let isQuitting = false

const usageDataPath = path.join(app.getPath('userData'), 'usage.json')

function normalizeRemotePath(remotePath: string) {
  const normalized = remotePath.replace(/\\/g, '/').trim()
  if (!normalized) return '/PCTime'
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

async function syncFileWithWebdav(client: any, localPath: string, remotePath: string) {
  const localStat = await fs.stat(localPath).catch(() => null)
  let remoteStat: { lastmod?: string } | null = null
  try {
    remoteStat = await client.stat(remotePath)
  } catch {
    remoteStat = null
  }

  const remoteTime = remoteStat?.lastmod ? new Date(remoteStat.lastmod).getTime() : 0
  const localTime = localStat?.mtimeMs ?? 0

  if (remoteStat && remoteTime > localTime + 1000) {
    const remoteData = await client.getFileContents(remotePath, { format: 'binary' })
    await fs.writeFile(localPath, remoteData as Buffer)
    return 'downloaded'
  }

  if (localStat) {
    const localData = await fs.readFile(localPath)
    await client.putFileContents(remotePath, localData, { overwrite: true })
    return 'uploaded'
  }

  return 'skipped'
}

let webdavModulePromise: Promise<any> | null = null

async function loadWebdav() {
  if (!webdavModulePromise) {
    webdavModulePromise = import('webdav')
  }
  return webdavModulePromise
}

async function syncWebdav(config: WebDavConfig) {
  if (!config.enabled || !config.url || !config.username || !config.password) {
    return { ok: false, message: 'WebDAV 配置不完整' }
  }
  let client: any
  try {
    const webdav = await loadWebdav()
    client = webdav.createClient(config.url, {
      username: config.username,
      password: config.password,
    })
  } catch (error) {
    console.error('webdav not available', error)
    return { ok: false, message: 'WebDAV 依赖加载失败' }
  }
  const basePath = normalizeRemotePath(config.remotePath)
  await client.createDirectory(basePath).catch(() => undefined)

  const usageRemote = `${basePath}/usage.json`
  const configRemote = `${basePath}/config.json`

  await syncFileWithWebdav(client, usageDataPath, usageRemote)
  await syncFileWithWebdav(client, getConfigPath(), configRemote)

  return { ok: true }
}

function scheduleSync() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (dailyTimer) {
    clearTimeout(dailyTimer)
    dailyTimer = null
  }
  const webdav = usageConfig?.webdav
  if (!webdav?.enabled) return
  if (webdav.syncMode === 'interval') {
    const minutes = webdav.syncIntervalMinutes || 5
    syncTimer = setInterval(() => {
      syncWebdav(webdav).catch(() => undefined)
    }, Math.max(1, minutes) * 60 * 1000)
    return
  }
  if (webdav.syncMode === 'daily' || webdav.syncMode === 'weekly') {
    const now = new Date()
    const next = new Date()
    next.setHours(webdav.syncHour || 0, webdav.syncMinute || 0, 0, 0)
    if (webdav.syncMode === 'weekly') {
      const target = webdav.syncWeekday ?? 1
      const day = next.getDay()
      let diff = (target - day + 7) % 7
      if (diff === 0 && next <= now) diff = 7
      next.setDate(next.getDate() + diff)
    } else if (next <= now) {
      next.setDate(next.getDate() + 1)
    }
    const delay = Math.max(1000, next.getTime() - now.getTime())
    dailyTimer = setTimeout(async () => {
      await syncWebdav(webdav).catch(() => undefined)
      scheduleSync()
    }, delay)
  }
}

function closeExtraWindows() {
  const windows = BrowserWindow.getAllWindows()
  windows.forEach((window) => {
    if (!win) {
      win = window
      return
    }
    if (window !== win) {
      window.close()
    }
  })
}

function shouldUseTray() {
  return Boolean(
    usageConfig?.appSettings?.minimizeToTray ||
      usageConfig?.appSettings?.closeToTray ||
      usageConfig?.appSettings?.startMinimized
  )
}

function getTrayIcon() {
  const iconPath = path.join(process.env.VITE_PUBLIC, 'electron-vite.svg')
  return nativeImage.createFromPath(iconPath)
}

function createTray() {
  if (tray) return
  const icon = getTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('PCTime')
  tray.on('click', () => {
    if (win) {
      win.show()
      win.focus()
    } else {
      createWindow()
    }
  })
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (win) {
          win.show()
          win.focus()
        } else {
          createWindow()
        }
      },
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
}

function updateAutoLaunch() {
  if (!usageConfig) return
  const enabled = Boolean(usageConfig.appSettings?.autoLaunch)
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: Boolean(usageConfig.appSettings?.startMinimized),
    })
  } catch (error) {
    console.error('Failed to set auto launch', error)
  }
}

function createWindow() {
  if (win && !win.isDestroyed()) {
    win.focus()
    return
  }

  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  win.on('minimize', (event: Event) => {
    if (usageConfig?.appSettings?.minimizeToTray) {
      event.preventDefault()
      win?.hide()
      createTray()
    }
  })

  win.on('close', (event: Event) => {
    if (!isQuitting && usageConfig?.appSettings?.closeToTray) {
      event.preventDefault()
      win?.hide()
      createTray()
    }
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  win.once('ready-to-show', () => {
    if (usageConfig?.appSettings?.startMinimized) {
      win?.hide()
      createTray()
    } else {
      win?.show()
    }
  })

  setTimeout(closeExtraWindows, 300)
}

app.on('browser-window-created', (_event, window) => {
  if (!win) {
    win = window
    return
  }
  if (window !== win) {
    window.close()
  }
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

if (process.platform === 'darwin') {
  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

if (!isDev) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      } else {
        createWindow()
      }
    })
  }
}

app.whenReady().then(async () => {
  usageConfig = await loadConfig()
  updateAutoLaunch()
  scheduleSync()
  if (shouldUseTray()) {
    createTray()
  }

  const resolveCategory = (appName: string, title: string) => {
    if (!usageConfig) return '其他'
    const lowerApp = appName.toLowerCase()
    const lowerTitle = title.toLowerCase()
    const match = usageConfig.rules.find((rule) => {
      const appOk = rule.appContains
        ? lowerApp.includes(rule.appContains.toLowerCase())
        : true
      const titleOk = rule.titleContains
        ? lowerTitle.includes(rule.titleContains.toLowerCase())
        : true
      return appOk && titleOk
    })
    return match?.category || usageConfig.defaultCategory || '其他'
  }

  const buildCategoryTotals = (windows: UsageSummary['windows']) => {
    const totals = new Map<string, number>()
    windows.forEach((entry) => {
      const category = resolveCategory(entry.app, entry.title)
      totals.set(category, (totals.get(category) ?? 0) + entry.totalMs)
    })
    const categories = usageConfig?.categories ?? Array.from(totals.keys())
    return categories
      .map((category) => ({ category, totalMs: totals.get(category) ?? 0 }))
      .sort((a, b) => b.totalMs - a.totalMs)
  }

  ipcMain.handle('usage:getSummary', (_event, args?: { range?: UsageRange; date?: string }) => {
    const range = args?.range ?? 'today'
    const date = args?.date
    const summary = usageTracker?.getSummary(range, date) ?? {
      range,
      date: date ?? new Date().toISOString().slice(0, 10),
      apps: [],
      windows: [],
    }
    const categories = buildCategoryTotals(summary.windows)
    return { ...summary, categories }
  })

  ipcMain.handle('usage:getConfig', () => {
    return usageConfig
  })

  ipcMain.handle('usage:setConfig', async (_event, config: UsageConfig) => {
    usageConfig = await saveConfig(config)
    updateAutoLaunch()
    if (shouldUseTray()) {
      createTray()
    }
    scheduleSync()
    return usageConfig
  })

  ipcMain.handle('usage:testWebdav', async () => {
    if (!usageConfig?.webdav) return { ok: false, message: '未配置 WebDAV' }
    try {
      const result = await syncWebdav({ ...usageConfig.webdav, enabled: true })
      return { ok: result.ok, message: result.ok ? '连接成功' : result.message }
    } catch (error) {
      return { ok: false, message: '连接失败' }
    }
  })

  ipcMain.handle('usage:syncNow', async () => {
    if (!usageConfig?.webdav) return { ok: false, message: '未配置 WebDAV' }
    try {
      const result = await syncWebdav({ ...usageConfig.webdav, enabled: true })
      if (result.ok) {
        usageConfig = await saveConfig({
          ...usageConfig,
          webdav: {
            ...usageConfig.webdav,
            lastSyncAt: new Date().toISOString(),
          },
        })
        usageConfig = await loadConfig()
        scheduleSync()
      }
      return { ok: result.ok, message: result.ok ? '同步完成' : result.message }
    } catch (error) {
      return { ok: false, message: '同步失败' }
    }
  })

  ipcMain.handle('usage:saveExport', async (_event, payload: { content: string; defaultPath: string }) => {
    const result = await dialog.showSaveDialog({
      defaultPath: payload.defaultPath,
      filters: [
        { name: 'Data', extensions: ['json', 'csv'] },
      ],
    })
    if (result.canceled || !result.filePath) {
      return { saved: false }
    }
    await fs.writeFile(result.filePath, payload.content, 'utf-8')
    return { saved: true, path: result.filePath }
  })

  try {
    usageTracker = await createUsageTracker()
  } catch (error) {
    console.error('Failed to start usage tracker', error)
  }

  createWindow()
  setTimeout(closeExtraWindows, 600)
})

app.on('before-quit', async () => {
  isQuitting = true
  if (usageConfig?.webdav?.enabled && usageConfig.webdav.syncMode === 'onClose') {
    await syncWebdav(usageConfig.webdav).catch(() => undefined)
  }
  if (usageTracker) {
    await usageTracker.stop()
  }
})
