import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function sourceModule(file) {
  const source = await readFile(new URL(`../electron/${file}.ts`, import.meta.url), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
}
async function pureModule(file) {
  return import(`data:text/javascript;base64,${Buffer.from(await sourceModule(file)).toString('base64')}`)
}
const configModel = await pureModule('configModel')
const lifecycle = await pureModule('lifecycle')
const webdavSync = await pureModule('webdavSync')

async function createHarness({ dev = false, customPath, trackerFailure, webdav } = {}) {
  const windows = []
  const handlers = new Map()
  const calls = []
  const directories = new Map([['userData', '/installed-data'], ['appData', '/app-data']])
  const app = new EventEmitter()
  Object.assign(app, {
    getPath: (name) => directories.get(name),
    setPath(name, directory) { directories.set(name, directory) },
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    setLoginItemSettings(value) { calls.push(['login', value]) },
    quit() { calls.push(['quit']) },
  })
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.webContents = new EventEmitter()
      this.webContents.send = () => {}
      this.webContents.mainFrame = { url: dev ? 'http://localhost:5173/' : new URL('../dist/index.html', import.meta.url).href }
      this.visible = false
      this.minimized = false
      this.destroyed = false
      windows.push(this)
      app.emit('browser-window-created', {}, this)
    }
    static getAllWindows() { return windows.filter((window) => !window.destroyed) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus() { this.focused = true }
    close() { this.destroyed = true; this.emit('closed') }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
  }
  let config = configModel.sanitizeConfig({
    ...configModel.DEFAULT_CONFIG,
    appSettings: { ...configModel.DEFAULT_CONFIG.appSettings, autoLaunch: true },
    webdav: { ...configModel.DEFAULT_CONFIG.webdav, ...webdav },
  })
  const tracker = {
    async stop() { calls.push(['stop-tracker']) },
    async flush() {}, async merge() {},
    getSummary() { return { range: 'today', date: '2026-09-23', apps: [], windows: [] } },
  }
  const cloud = {
    start() { calls.push(['start-cloud']) },
    async stop() { calls.push(['stop-cloud']) },
    record() {},
    getState() { return { serverUrl: '', user: null, device: null, syncing: false, lastSyncedAt: null, error: null } },
    async authenticate() { return this.getState() }, async logout() { return this.getState() },
    async syncNow() { return this.getState() }, async getSummary() { return { date: '2026-09-23', metric: 'sumDevices', totalMs: 0, devices: [], apps: [], updatedAt: null } },
  }
  const dependencies = {
    electron: { app, BrowserWindow, Tray, Menu: { buildFromTemplate: (value) => value }, nativeImage: { createFromPath: (file) => file },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showErrorBox() {}, async showSaveDialog() { return { canceled: true } } } },
    'node:url': { fileURLToPath }, 'node:path': { default: path },
    'node:fs': { mkdirSync(directory) { calls.push(['mkdir', directory]) } },
    'node:fs/promises': { default: { async readFile() { return '{"dates":{}}' }, async writeFile() {} } },
    './usageTracker': { async createUsageTracker() { if (trackerFailure) throw new Error(trackerFailure); return tracker } },
    './configStore': { async loadConfig() { return config }, async saveConfig(value) { config = configModel.sanitizeConfig(value); return config } },
    './configModel': configModel, './lifecycle': lifecycle, './webdavSync': webdavSync,
    './cloudService': { async createCloudService() { return cloud } },
  }
  const env = {}
  if (dev) env.VITE_DEV_SERVER_URL = 'http://localhost:5173'
  if (customPath) env.PCTIME_USER_DATA = customPath
  const context = vm.createContext({
    console: { ...console, error() {} }, Error, URL, process: { platform: 'win32', env },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
  })
  const webdavModule = new vm.SyntheticModule(['createClient'], function () {
    this.setExport('createClient', () => ({
      async stat() {}, async createDirectory() {},
      async getFileContents() { return '{"dates":{}}' },
      async putFileContents() {},
    }))
  }, { context })
  await webdavModule.link(() => { throw new Error('Unexpected WebDAV dependency') })
  await webdavModule.evaluate()
  const module = new vm.SourceTextModule(await sourceModule('main'), {
    context, initializeImportMeta(meta) { meta.url = new URL('../electron/main.ts', import.meta.url).href },
    async importModuleDynamically(specifier) {
      assert.equal(specifier, 'webdav')
      return webdavModule
    },
  })
  await module.link((specifier) => {
    const values = dependencies[specifier]
    assert.ok(values, `Unexpected dependency ${specifier}`)
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  await new Promise((resolve) => setImmediate(resolve))
  return { app, windows, calls, handlers, directories, config }
}

test('development startup isolates data and never changes login registration', async () => {
  const harness = await createHarness({ dev: true })
  assert.equal(harness.directories.get('userData'), path.join('/app-data', 'PCTime-dev'))
  assert.equal(harness.calls.some(([name]) => name === 'login'), false)
  assert.equal(harness.windows[0].options.width, 1280)
  assert.equal(harness.windows[0].options.minWidth, 760)
  assert.equal(harness.windows[0].options.title, 'PCTime')
})

test('explicit test data directory also avoids changing startup registration', async () => {
  const harness = await createHarness({ customPath: '/isolated-test-data' })
  assert.equal(harness.directories.get('userData'), path.resolve('/isolated-test-data'))
  assert.equal(harness.calls.some(([name]) => name === 'login'), false)
})

test('cloud account IPC rejects another window, subframes and an externally navigated page', async () => {
  const harness = await createHarness({ dev: true })
  const contents = harness.windows[0].webContents
  const handler = harness.handlers.get('cloud:getState')
  assert.equal(handler({ sender: contents, senderFrame: contents.mainFrame }).user, null)
  assert.throws(() => handler({ sender: {}, senderFrame: contents.mainFrame }), /无法从此页面/)
  assert.throws(() => handler({ sender: contents, senderFrame: { url: contents.mainFrame.url } }), /无法从此页面/)
  contents.mainFrame.url = 'https://untrusted.example/'
  assert.throws(() => handler({ sender: contents, senderFrame: contents.mainFrame }), /无法从此页面/)
})

test('shutdown flushes the independent collector after stopping foreground sampling', async () => {
  const harness = await createHarness()
  harness.app.emit('before-quit', { preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  const order = harness.calls.map(([name]) => name)
  assert.ok(order.indexOf('stop-tracker') < order.indexOf('stop-cloud'))
  assert.ok(order.indexOf('stop-cloud') < order.lastIndexOf('quit'))
})

test('a second launch shows and restores a hidden minimized window', async () => {
  const harness = await createHarness()
  const window = harness.windows[0]
  window.hide()
  window.minimized = true
  harness.app.emit('second-instance')
  assert.equal(window.visible, true)
  assert.equal(window.minimized, false)
  assert.equal(window.focused, true)
})

test('tracker startup errors reach the renderer instead of showing empty statistics', async () => {
  const harness = await createHarness({ trackerFailure: 'invalid usage history' })
  assert.throws(() => harness.handlers.get('usage:getSummary')({}, {}), /invalid usage history.*检查数据文件和目录权限后重启 PCTime/)
})

test('manual sync remains disabled until the user saves enabled settings', async () => {
  const harness = await createHarness()
  const result = await harness.handlers.get('usage:syncNow')()
  assert.equal(result.ok, false)
  assert.match(result.message, /启用并保存/)
})

test('saving an older settings draft preserves the last successful sync timestamp', async () => {
  const previousSync = '2020-01-01T00:00:00.000Z'
  const harness = await createHarness({ webdav: {
    enabled: true, url: 'https://example.test/dav', username: 'test', password: 'test', lastSyncAt: previousSync,
  } })
  const olderDraft = structuredClone(harness.handlers.get('usage:getConfig')())
  olderDraft.defaultCategory = '工作'
  const result = await harness.handlers.get('usage:syncNow')()
  assert.equal(result.ok, true, result.message)
  const latestSync = harness.handlers.get('usage:getConfig')().webdav.lastSyncAt
  assert.notEqual(latestSync, previousSync)
  const saved = await harness.handlers.get('usage:setConfig')({}, olderDraft)
  assert.equal(saved.webdav.lastSyncAt, latestSync)
  assert.equal(saved.defaultCategory, '工作')
})
