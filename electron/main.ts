import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron'
import type { Event } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { createUsageTracker, UsageRange, UsageSummary } from './usageTracker'
import { loadConfig, saveConfig, UsageConfig, WebDavConfig } from './configStore'
import { createSerialQueue, resolveCategory } from './configModel'
import { createQuitHandler } from './lifecycle'
import { syncUsageWithWebdav, testWebdavConnection, validateWebdav, webdavErrorMessage } from './webdavSync'
import type { WebdavClient } from './webdavSync'

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

// Development and automated checks must not alter the installed app's history.
const customUserData = process.env.PCTIME_USER_DATA
if (customUserData || isDev) {
  const dataDirectory = customUserData ? path.resolve(customUserData) : path.join(app.getPath('appData'), 'PCTime-dev')
  mkdirSync(dataDirectory, { recursive: true })
  app.setPath('userData', dataDirectory)
}

let win: BrowserWindow | null
let usageTracker: Awaited<ReturnType<typeof createUsageTracker>> | null = null
let trackerError: string | null = null
let usageConfig: UsageConfig | null = null
let syncTimer: NodeJS.Timeout | null = null
let dailyTimer: NodeJS.Timeout | null = null
let tray: Tray | null = null
let isQuitting = false

const usageDataPath = path.join(app.getPath('userData'), 'usage.json')
const enqueueConfigOperation = createSerialQueue()

let webdavModulePromise: Promise<typeof import('webdav')> | null = null

async function loadWebdav() {
  if (!webdavModulePromise) {
    webdavModulePromise = import('webdav')
  }
  return webdavModulePromise
}

async function createWebdavClient(config: WebDavConfig): Promise<WebdavClient> {
  validateWebdav(config)
  const webdav = await loadWebdav()
  return webdav.createClient(config.url, {
    username: config.username,
    password: config.password,
    timeout: 15000,
  })
}

async function syncWebdav() {
  if (!usageConfig) throw new Error('未配置 WebDAV')
  if (!usageTracker) throw new Error('统计服务尚未就绪，暂时无法同步')
  const client = await createWebdavClient(usageConfig.webdav)
  await syncUsageWithWebdav(client, {
    remotePath: usageConfig.webdav.remotePath,
    flush: usageTracker.flush,
    merge: usageTracker.merge,
    readUsage: () => fs.readFile(usageDataPath, 'utf-8'),
    config: usageConfig,
  })
  usageConfig = await saveConfig({
    ...usageConfig,
    webdav: { ...usageConfig.webdav, lastSyncAt: new Date().toISOString() },
  })
  return { ok: true, message: '同步完成' }
}

function runScheduledSync() {
  return enqueueConfigOperation(async () => {
    if (!usageConfig?.webdav.enabled || isQuitting) return
    try { await syncWebdav() } catch (error) { console.error('WebDAV sync failed:', webdavErrorMessage(error)) }
  })
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
  if (!webdav?.enabled || isQuitting) return
  if (webdav.syncMode === 'interval') {
    const minutes = webdav.syncIntervalMinutes
    syncTimer = setInterval(() => {
      void runScheduledSync()
    }, Math.max(1, minutes) * 60 * 1000)
    return
  }
  if (webdav.syncMode === 'daily' || webdav.syncMode === 'weekly') {
    const now = new Date()
    const next = new Date()
    next.setHours(webdav.syncHour, webdav.syncMinute, 0, 0)
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
      await runScheduledSync()
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
  const iconPath = path.join(process.env.VITE_PUBLIC, 'pctime.png')
  return nativeImage.createFromPath(iconPath)
}

function createTray() {
  if (tray) return
  const icon = getTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('PCTime')
  tray.on('click', showWindow)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: showWindow,
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
  if (!usageConfig || isDev || customUserData) return
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

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    createWindow(true)
  }
}

function createWindow(forceShow = false) {
  if (win && !win.isDestroyed()) {
    showWindow()
    return
  }

  win = new BrowserWindow({
    title: 'PCTime',
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    icon: path.join(process.env.VITE_PUBLIC, 'pctime.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  win.on('closed', () => { win = null })

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
    if (!forceShow && usageConfig?.appSettings?.startMinimized) {
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
    showWindow()
  })
}

if (!isDev) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      showWindow()
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

  const buildCategoryTotals = (windows: UsageSummary['windows']) => {
    const totals = new Map<string, number>()
    windows.forEach((entry) => {
      const category = usageConfig ? resolveCategory(usageConfig, entry.app, entry.title) : '其他'
      totals.set(category, (totals.get(category) ?? 0) + entry.totalMs)
    })
    const categories = usageConfig?.categories ?? Array.from(totals.keys())
    return categories
      .map((category) => ({ category, totalMs: totals.get(category) ?? 0 }))
      .sort((a, b) => b.totalMs - a.totalMs)
  }

  ipcMain.handle('usage:getSummary', (_event, args?: { range?: UsageRange; date?: string }) => {
    if (trackerError) throw new Error(trackerError)
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

  ipcMain.handle('usage:setConfig', (_event, config: UsageConfig) => enqueueConfigOperation(async () => {
    usageConfig = await saveConfig({
      ...config,
      // This status belongs to the main process; an older form draft must not
      // undo the successful sync that completed while the user was editing.
      webdav: { ...config.webdav, lastSyncAt: usageConfig?.webdav.lastSyncAt },
    })
    updateAutoLaunch()
    if (shouldUseTray()) {
      createTray()
    }
    scheduleSync()
    return usageConfig
  }))

  ipcMain.handle('usage:testWebdav', () => enqueueConfigOperation(async () => {
    if (!usageConfig?.webdav) return { ok: false, message: '未配置 WebDAV' }
    try {
      const client = await createWebdavClient(usageConfig.webdav)
      return await testWebdavConnection(client, usageConfig.webdav.remotePath)
    } catch (error) {
      return { ok: false, message: webdavErrorMessage(error) }
    }
  }))

  ipcMain.handle('usage:syncNow', () => enqueueConfigOperation(async () => {
    if (!usageConfig?.webdav) return { ok: false, message: '未配置 WebDAV' }
    if (!usageConfig.webdav.enabled) return { ok: false, message: '请先启用并保存 WebDAV 设置' }
    try {
      return await syncWebdav()
    } catch (error) {
      return { ok: false, message: webdavErrorMessage(error) }
    }
  }))

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
    const detail = error instanceof Error ? `：${error.message}。` : '。'
    trackerError = `统计服务未能启动${detail}请检查数据文件和目录权限后重启 PCTime。`
  }

  createWindow()
  setTimeout(closeExtraWindows, 600)
}).catch((error) => {
  console.error('Failed to initialize PCTime', error)
  dialog.showErrorBox('PCTime 启动失败', '无法读取或保存配置，请检查数据目录权限和磁盘空间。')
  app.quit()
})

app.on('before-quit', createQuitHandler({
  onStart: () => {
    isQuitting = true
    if (syncTimer) clearInterval(syncTimer)
    if (dailyTimer) clearTimeout(dailyTimer)
  },
  finish: () => enqueueConfigOperation(async () => {
    // Flush the final sample before uploading, and keep Electron alive until done.
    await usageTracker?.stop()
    if (usageConfig?.webdav.enabled && usageConfig.webdav.syncMode === 'onClose') {
      try { await syncWebdav() } catch (error) { console.error('WebDAV sync failed:', webdavErrorMessage(error)) }
    }
  }),
  onError: (error) => {
    console.error('Failed to save usage before quitting', error)
    dialog.showErrorBox('PCTime 保存失败', '最后一段统计未能保存，请检查数据目录权限和磁盘空间。')
  },
  quit: () => app.quit(),
}))
