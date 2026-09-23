import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/usage.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
const { searchUsage, exportData, shiftDate, duration } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)
const summary = {
  range: 'today', date: '2026-09-23',
  apps: Array.from({ length: 25 }, (_, index) => ({ app: `App ${index}`, totalMs: (25 - index) * 1000 })),
  windows: [{ app: 'Microsoft Edge', title: '=HYPERLINK("bad")', totalMs: 1000 }, { app: 'Editor', title: 'Notes, "today"\nsecond line', totalMs: 2000 }],
  categories: [{ category: '工作', totalMs: 3000 }],
}

test('all entries stay searchable past the old ten-item cutoff', () => {
  assert.equal(searchUsage(summary, 'apps', '').length, 25)
  assert.equal(searchUsage(summary, 'apps', ' app 24 ')[0].app, 'App 24')
  assert.equal(searchUsage(summary, 'windows', 'notes')[0].app, 'Editor')
  assert.equal(searchUsage(summary, 'windows', '', 'Microsoft Edge').length, 1)
  assert.equal(searchUsage(null, 'apps', '').length, 0)
})

test('statistics JSON exports only the selected summary, never connection credentials', () => {
  const result = JSON.parse(exportData(summary, 'json'))
  assert.deepEqual(Object.keys(result), ['summary'])
  assert.deepEqual(result.summary, summary)
})

test('CSV supports Chinese Excel text and escapes formulas, quotes, commas and newlines', () => {
  const csv = exportData(summary, 'csv')
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'))
  assert.ok(csv.includes('"Notes, ""today""\nsecond line"'))
  assert.ok(csv.includes('"工作"'))
})

test('date navigation uses local calendar arithmetic across months and leap days', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29')
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
})

test('sub-minute activity remains visible and negative durations do not leak into UI', () => {
  assert.equal(duration(47000), '47 秒')
  assert.equal(duration(-100), '0 秒')
  assert.equal(duration(3600000), '1 小时 0 分钟')
})
