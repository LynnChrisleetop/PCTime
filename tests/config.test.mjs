import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadSource(file) {
  const source = await readFile(new URL(`../electron/${file}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)
}
const { DEFAULT_CONFIG, sanitizeConfig, resolveCategory, createSerialQueue } = await loadSource('configModel')
const { createQuitHandler } = await loadSource('lifecycle')

test('midnight and Sunday survive saving while invalid schedule values are bounded', () => {
  const config = sanitizeConfig({ ...DEFAULT_CONFIG, webdav: { syncHour: 0, syncMinute: 0, syncWeekday: 0 } })
  assert.equal(config.webdav.syncHour, 0)
  assert.equal(config.webdav.syncWeekday, 0)
  const bounded = sanitizeConfig({ ...DEFAULT_CONFIG, webdav: { syncHour: 99, syncMinute: -1, syncWeekday: 8, syncIntervalMinutes: 0 } })
  assert.equal(bounded.webdav.syncHour, 23)
  assert.equal(bounded.webdav.syncMinute, 0)
  assert.equal(bounded.webdav.syncWeekday, 6)
  assert.equal(bounded.webdav.syncIntervalMinutes, 1)
})

test('empty rules never match all windows and both supplied criteria must match', () => {
  const config = { ...DEFAULT_CONFIG, rules: [
    { id: 'empty', category: '娱乐', appContains: ' ', titleContains: '' },
    { id: 'video', category: '娱乐', appContains: 'edge', titleContains: 'bilibili' },
  ] }
  assert.equal(resolveCategory(config, 'Editor', 'Project'), '其他')
  assert.equal(resolveCategory(config, 'Microsoft Edge', 'GitHub'), '其他')
  assert.equal(resolveCategory(config, 'Microsoft Edge', 'BILIBILI'), '娱乐')
  assert.equal(sanitizeConfig(config).rules.length, 1)
})

test('categories are trimmed and deduplicated and removed categories stay removed', () => {
  const config = sanitizeConfig({ categories: [' 工作 ', '工作', '', '其他'], rules: [], categoryColors: { 工作: '#123456', 其他: 'broken' } })
  assert.deepEqual(config.categories, ['工作', '其他'])
  assert.equal(config.categoryColors.工作, '#123456')
  assert.equal(config.categoryColors.其他, '#c9ced3')
  assert.equal(config.appSettings.closeToTray, true)
  assert.deepEqual(sanitizeConfig(null).categories, DEFAULT_CONFIG.categories)
})

test('save queue preserves submission order and continues after a failed save', async () => {
  const enqueue = createSerialQueue()
  const writes = []
  let release
  const first = enqueue(async () => {
    writes.push('start-first')
    await new Promise((resolve) => { release = resolve })
    writes.push('finish-first')
  })
  const second = enqueue(async () => { writes.push('second'); throw new Error('disk full') })
  const rejection = assert.rejects(second, /disk full/)
  const third = enqueue(async () => { writes.push('third') })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(writes, ['start-first'])
  release()
  await Promise.all([first, rejection, third])
  assert.deepEqual(writes, ['start-first', 'finish-first', 'second', 'third'])
})

test('quit is prevented until pending persistence finishes and repeated quit requests share it', async () => {
  let release
  let prevented = 0
  let stops = 0
  let exits = 0
  const handler = createQuitHandler({
    onStart() { stops++ },
    finish: () => new Promise((resolve) => { release = resolve }),
    quit() { exits++ },
    onError(error) { throw error },
  })
  const event = { preventDefault() { prevented++ } }
  const first = handler(event)
  const repeated = handler(event)
  assert.equal(first, repeated)
  assert.equal(prevented, 2)
  assert.equal(stops, 1)
  assert.equal(exits, 0)
  await Promise.resolve()
  release()
  await first
  assert.equal(exits, 1)
  handler(event)
  assert.equal(prevented, 2)
})

test('quit reports a persistence failure once and still completes shutdown', async () => {
  const calls = []
  const handler = createQuitHandler({
    onStart() { calls.push('stop') },
    async finish() { throw new Error('disk full') },
    onError(error) { calls.push(error.message) },
    quit() { calls.push('quit') },
  })
  await handler({ preventDefault() {} })
  assert.deepEqual(calls, ['stop', 'disk full', 'quit'])
})
