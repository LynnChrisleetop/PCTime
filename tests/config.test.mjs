import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

function sourceUrl(source) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
  return `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
}
async function loadSource(file) {
  const source = await readFile(new URL(`../electron/${file}.ts`, import.meta.url), 'utf8')
  return import(sourceUrl(source))
}
const { DEFAULT_CONFIG, sanitizeConfig, resolveCategory, createSerialQueue } = await loadSource('configModel')
const { createQuitHandler } = await loadSource('lifecycle')
const newPalette = { 工作: '#147d9e', 学习: '#f4cc39', 娱乐: '#f48158', 社交: '#a49bca', 其他: '#cbd5df' }
const legacyPalettes = [
  { 工作: '#f87171', 学习: '#34d399', 娱乐: '#fbbf24', 社交: '#60a5fa', 其他: '#9ca3af' },
  { 工作: '#197568', 学习: '#82afa0', 娱乐: '#d6b278', 社交: '#8a9bb8', 其他: '#c9ced3' },
]

test('new installations use the A palette and missing colors use its defaults', () => {
  assert.deepEqual(DEFAULT_CONFIG.categoryColors, newPalette)
  assert.deepEqual(sanitizeConfig(null).categoryColors, newPalette)
  const partial = sanitizeConfig({ categories: ['工作', '学习', '自定义', '其他'], categoryColors: { 工作: '#123456' } })
  assert.equal(partial.categoryColors.工作, '#123456')
  assert.equal(partial.categoryColors.学习, newPalette.学习)
  assert.equal(partial.categoryColors.自定义, newPalette.其他)
})

test('demo mode and new installations use the same A palette', async () => {
  const usageSource = await readFile(new URL('../src/lib/usage.ts', import.meta.url), 'utf8')
  const demoSource = await readFile(new URL('../src/lib/demo.ts', import.meta.url), 'utf8')
  const { demoApi } = await import(sourceUrl(demoSource.replace("'./usage'", JSON.stringify(sourceUrl(usageSource)))))
  const config = await demoApi.getConfig()
  assert.deepEqual(config.categoryColors, DEFAULT_CONFIG.categoryColors)
  assert.equal(config.categoryPaletteVersion, DEFAULT_CONFIG.categoryPaletteVersion)
})

test('the complete untouched green default palette migrates together and remains stable', () => {
  const categoryColors = legacyPalettes[1]
  const original = { categories: [...DEFAULT_CONFIG.categories], categoryColors, defaultCategory: '学习', rules: [] }
  const config = sanitizeConfig(original)
  assert.deepEqual(config.categoryColors, newPalette)
  assert.equal(config.defaultCategory, '学习')
  assert.deepEqual(config.rules, [])
  assert.deepEqual(sanitizeConfig(config), config)
  assert.deepEqual(original.categoryColors, categoryColors)
})

test('an older unrelated palette is not treated as the known green defaults', () => {
  const categoryColors = legacyPalettes[0]
  const config = sanitizeConfig({ categories: DEFAULT_CONFIG.categories, categoryColors })
  assert.deepEqual(config.categoryColors, categoryColors)
  assert.equal(config.categoryPaletteVersion, 1)
  assert.deepEqual(sanitizeConfig(config), config)
})

test('one customized color protects the entire existing palette', () => {
  for (const legacy of legacyPalettes) {
    const categoryColors = { ...legacy, 学习: '#123456' }
    const config = sanitizeConfig({ categories: [...DEFAULT_CONFIG.categories], categoryColors })
    assert.deepEqual(config.categoryColors, categoryColors)
    assert.deepEqual(sanitizeConfig(config), config)
  }
})

test('added categories or additional saved colors prevent automatic palette migration', () => {
  const legacy = legacyPalettes[1]
  for (const categories of [DEFAULT_CONFIG.categories, [...DEFAULT_CONFIG.categories, '阅读']]) {
    const categoryColors = { ...legacy, 阅读: '#314159' }
    const config = sanitizeConfig({ categories, categoryColors })
    assert.deepEqual(config.categoryColors, categoryColors)
    assert.deepEqual(sanitizeConfig(config), config)
  }
})

test('incomplete or modified category sets do not become eligible after normalization', () => {
  const legacy = legacyPalettes[1]
  for (const categories of [DEFAULT_CONFIG.categories.filter((category) => category !== '其他'), [...DEFAULT_CONFIG.categories, '工作']]) {
    const config = sanitizeConfig({ categories, categoryColors: legacy })
    assert.deepEqual(config.categoryColors, legacy)
    assert.deepEqual(sanitizeConfig(config), config)
  }
  const colors = { ...legacy }
  delete colors.社交
  const incomplete = sanitizeConfig({ categories: DEFAULT_CONFIG.categories, categoryColors: colors })
  assert.equal(incomplete.categoryColors.工作, legacy.工作)
  assert.equal(incomplete.categoryColors.社交, newPalette.社交)
  assert.deepEqual(sanitizeConfig(incomplete), incomplete)
})

test('a user can deliberately choose the old palette after migration without it being reset', () => {
  const config = sanitizeConfig({
    ...sanitizeConfig(null),
    categoryColors: legacyPalettes[1],
  })
  assert.deepEqual(config.categoryColors, legacyPalettes[1])
  assert.deepEqual(sanitizeConfig(config), config)
})

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
  assert.equal(config.categoryColors.其他, '#cbd5df')
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
