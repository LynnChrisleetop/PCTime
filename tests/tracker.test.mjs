import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Only the OS, clock and disk boundaries are replaced. Every test executes the
// production tracker, including its scheduling, accounting and persistence.
async function createHarness({ stored = { dates: {} }, start = new Date(2026, 8, 23, 12).getTime(), moduleError } = {}) {
  let now = start
  let idle = 0
  let sample = async () => windowInfo('Editor', 'Project')
  const timers = new Map()
  const files = new Map([[path.join('/test-data', 'usage.json'), JSON.stringify(stored)]])
  let write = async (file, data) => { files.set(file, data) }
  const powerMonitor = new EventEmitter()
  powerMonitor.getSystemIdleTime = () => idle
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const context = vm.createContext({
    console, Date: Clock, process,
    setInterval(fn, ms) { const timer = { fn, ms }; timers.set(timer, timer); return timer },
    clearInterval(timer) { timers.delete(timer) },
  })
  const dependencies = {
    electron: { app: { getPath: () => '/test-data' }, powerMonitor },
    'node:module': { createRequire: () => () => {
      if (moduleError) throw new Error(moduleError)
      return () => sample()
    } },
    'node:fs/promises': { default: {
      async readFile(file) {
        if (!files.has(file)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' })
        return files.get(file)
      },
      async writeFile(file, data) { await write(file, data) },
      async rename(from, to) { files.set(to, files.get(from)); files.delete(from) },
    } },
    'node:path': { default: path },
  }
  const source = await readFile(new URL('../electron/usageTracker.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
  const module = new vm.SourceTextModule(compiled.outputText, { context, initializeImportMeta(meta) { meta.url = import.meta.url } })
  await module.link((specifier) => {
    const values = dependencies[specifier]
    assert.ok(values, `Unexpected dependency: ${specifier}`)
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  const tracker = await module.namespace.createUsageTracker()
  return {
    tracker, powerMonitor, files,
    setIdle(value) { idle = value },
    setSample(value) { sample = value },
    setWrite(value) { write = value },
    async tick(at = now + 1000) {
      now = at
      for (const { fn, ms } of [...timers.values()]) if (ms === 1000) fn()
      await new Promise((resolve) => setImmediate(resolve))
    },
    async saveTick() {
      for (const { fn, ms } of [...timers.values()]) if (ms === 10000) fn()
      await new Promise((resolve) => setImmediate(resolve))
    },
    async settle() { await new Promise((resolve) => setImmediate(resolve)) },
  }
}

function windowInfo(app, title) {
  return { platform: 'windows', owner: { name: app, processId: 12345, path: '/test/editor' }, title, id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, memoryUsage: 0 }
}

function total(tracker, date) {
  return tracker.getSummary(date ? 'date' : 'all', date).apps.reduce((sum, app) => sum + app.totalMs, 0)
}

test('restart preserves historical totals without counting time while PCTime was closed', async () => {
  const start = new Date(2026, 8, 23, 12).getTime()
  const h = await createHarness({ start, stored: {
    dates: { '2026-09-23': { apps: { Editor: { totalMs: 3000, lastUpdated: start - 3600000 } }, windows: { 'Editor::Project': { app: 'Editor', title: 'Project', totalMs: 3000, lastUpdated: start - 3600000 } } } },
    current: { app: 'Editor', title: 'Project', windowKey: 'Editor::Project' }, lastTick: start - 3600000,
  } })
  await h.tick()
  assert.equal(total(h.tracker), 3000)
  await h.tick()
  assert.equal(total(h.tracker), 4000)
  await h.tracker.stop()
})

test('an interval crossing local midnight is split between both dates', async () => {
  const midnight = new Date(2026, 8, 24).getTime()
  const h = await createHarness({ start: midnight - 1500 })
  await h.tick(midnight - 500)
  await h.tick(midnight + 500)
  assert.equal(total(h.tracker, '2026-09-23'), 500)
  assert.equal(total(h.tracker, '2026-09-24'), 500)
  await h.tracker.stop()
})

test('idle stops the current indicator and does not charge the previous window on return', async () => {
  const h = await createHarness()
  await h.tick()
  await h.tick()
  h.setIdle(65)
  await h.tick()
  assert.equal(h.tracker.getSummary('today').current, undefined)
  h.setIdle(0)
  h.setSample(async () => windowInfo('Browser', 'Search'))
  await h.tick()
  assert.equal(total(h.tracker), 1000)
  await h.tick()
  assert.equal(total(h.tracker), 2000)
  await h.tracker.stop()
})

test('PCTime excludes its own window and does not leave a stale app active', async () => {
  const h = await createHarness()
  await h.tick()
  h.setSample(async () => windowInfo('Electron', 'PCTime'))
  await h.tick()
  assert.equal(h.tracker.getSummary('today').current, undefined)
  await h.tick()
  h.setSample(async () => windowInfo('Browser', 'Search'))
  await h.tick()
  assert.equal(total(h.tracker), 1000)
  await h.tracker.stop()
})

test('suspend and resume do not count sleeping time', async () => {
  const start = new Date(2026, 8, 23, 12).getTime()
  const h = await createHarness({ start })
  await h.tick(start + 1000)
  h.powerMonitor.emit('suspend')
  h.powerMonitor.emit('resume')
  await h.tick(start + 3600000)
  assert.equal(total(h.tracker), 0)
  await h.tick(start + 3601000)
  assert.equal(total(h.tracker), 1000)
  await h.tracker.stop()
})

test('a slow window lookup cannot overlap or overwrite a later sample', async () => {
  const start = new Date(2026, 8, 23, 12).getTime()
  const h = await createHarness({ start })
  await h.tick(start + 1000)
  let resolveLookup
  h.setSample(() => new Promise((resolve) => { resolveLookup = resolve }))
  await h.tick(start + 2000)
  const firstResolve = resolveLookup
  h.setSample(async () => windowInfo('Browser', 'Search'))
  await h.tick(start + 3000)
  firstResolve(windowInfo('Editor', 'Project'))
  await h.settle()
  await h.tick(start + 4000)
  assert.equal(total(h.tracker), 3000)
  assert.equal(h.tracker.getSummary('today').current.app, 'Browser')
  await h.tracker.stop()
})

test('failed foreground reads clear current activity until a fresh sample arrives', async () => {
  const h = await createHarness()
  await h.tick()
  h.setSample(async () => { throw new Error('window disappeared') })
  await h.tick()
  assert.equal(h.tracker.getSummary('today').current, undefined)
  h.setSample(async () => windowInfo('Browser', 'Search'))
  await h.tick()
  assert.equal(total(h.tracker), 0)
  await h.tracker.stop()
})

test('merging remote usage retains local activity and takes the greatest time for matching windows', async () => {
  const h = await createHarness()
  await h.tick()
  await h.tick()
  await h.tracker.merge({ dates: { '2026-09-23': {
    apps: { Editor: { totalMs: 4000, lastUpdated: 0 } },
    windows: {
      'Editor::Project': { app: 'Editor', title: 'Project', totalMs: 500, lastUpdated: 0 },
      'Editor::Other': { app: 'Editor', title: 'Other', totalMs: 3500, lastUpdated: 0 },
    },
  } } })
  assert.equal(total(h.tracker), 4500)
  assert.equal(h.tracker.getSummary('today').current.app, 'Editor')
  await h.tick()
  assert.equal(total(h.tracker), 5500)
  await h.tracker.flush()
  const persisted = JSON.parse(h.files.get(path.join('/test-data', 'usage.json')))
  assert.equal(persisted.dates['2026-09-23'].apps.Editor.totalMs, 5500)
  assert.equal(persisted.current, undefined)
  assert.equal(persisted.lastTick, undefined)
  await h.tracker.stop()
})

test('invalid remote data is rejected without changing live history', async () => {
  const h = await createHarness()
  await h.tick()
  await h.tick()
  await assert.rejects(h.tracker.merge({ dates: { '2026-09-23': { apps: { Editor: { totalMs: -1 } }, windows: {} } } }))
  assert.equal(total(h.tracker), 1000)
  await h.tracker.stop()
})

test('an interrupted save leaves the previous usage file intact', async () => {
  const h = await createHarness()
  const original = h.files.get(path.join('/test-data', 'usage.json'))
  await h.tick()
  await h.tick()
  h.setWrite(async (file) => { h.files.set(file, '{'); throw new Error('disk unavailable') })
  await assert.rejects(h.tracker.flush(), /disk unavailable/)
  assert.equal(h.files.get(path.join('/test-data', 'usage.json')), original)
  h.setWrite(async (file, data) => { h.files.set(file, data) })
  await h.tracker.stop()
})

test('concurrent flushes cannot let an older snapshot replace newer usage', async () => {
  const h = await createHarness()
  await h.tick()
  await h.tick()
  let finishFirst
  let isFirst = true
  h.setWrite(async (file, data) => {
    if (isFirst) {
      isFirst = false
      await new Promise((resolve) => { finishFirst = resolve })
    }
    h.files.set(file, data)
  })
  const first = h.tracker.flush()
  await h.settle()
  await h.tick()
  const second = h.tracker.flush()
  await h.settle()
  finishFirst()
  await Promise.all([first, second])
  const persisted = JSON.parse(h.files.get(path.join('/test-data', 'usage.json')))
  assert.equal(persisted.dates['2026-09-23'].apps.Editor.totalMs, 2000)
  await h.tracker.stop()
})

test('unavailable tracking dependencies are reported without hiding history or exposing raw errors', async () => {
  const h = await createHarness({ moduleError: 'native.dll failed: private-folder', stored: {
    dates: { '2026-09-23': { apps: { Editor: { totalMs: 3000 } }, windows: {} } },
  } })
  const summary = h.tracker.getSummary('today')
  assert.ok(summary.trackingError)
  assert.equal(summary.trackingError.includes('private-folder'), false)
  assert.equal(total(h.tracker), 3000)
  await h.tracker.stop()
})

test('sampling failure has a recoverable health status while preserving existing totals', async () => {
  const h = await createHarness()
  await h.tick()
  await h.tick()
  h.setSample(async () => { throw new Error('private-document-title') })
  await h.tick()
  assert.ok(h.tracker.getSummary('today').trackingError)
  assert.equal(h.tracker.getSummary('today').trackingError.includes('private-document-title'), false)
  assert.equal(total(h.tracker), 1000)
  h.setSample(async () => windowInfo('Browser', 'Search'))
  await h.tick()
  assert.equal(h.tracker.getSummary('today').trackingError, undefined)
  assert.equal(h.tracker.getSummary('today').current.app, 'Browser')
  await h.tick()
  assert.equal(total(h.tracker), 2000)
  await h.tracker.stop()
})

test('background save failure is visible and clears only after a successful retry', async () => {
  const h = await createHarness()
  await h.tick()
  await h.tick()
  h.setWrite(async () => { throw new Error('private-data-path') })
  await h.saveTick()
  assert.ok(h.tracker.getSummary('today').saveError)
  assert.equal(h.tracker.getSummary('today').saveError.includes('private-data-path'), false)
  assert.equal(total(h.tracker), 1000)
  h.setWrite(async (file, data) => { h.files.set(file, data) })
  await h.saveTick()
  assert.equal(h.tracker.getSummary('today').saveError, undefined)
  assert.equal(JSON.parse(h.files.get(path.join('/test-data', 'usage.json'))).dates['2026-09-23'].apps.Editor.totalMs, 1000)
  await h.tracker.stop()
})
