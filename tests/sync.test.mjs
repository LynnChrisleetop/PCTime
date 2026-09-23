import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../electron/webdavSync.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
const { normalizeRemotePath, testWebdavConnection, syncUsageWithWebdav, webdavErrorMessage } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)
const notFound = () => Object.assign(new Error('not found'), { status: 404 })

function syncHarness(remote = '{"dates":{}}') {
  const calls = []
  const uploads = new Map()
  const client = {
    async stat(directory) { calls.push(['stat', directory]) },
    async createDirectory(directory) { calls.push(['create', directory]) },
    async getFileContents(file) { calls.push(['get', file]); return remote },
    async putFileContents(file, body) { calls.push(['put', file]); uploads.set(file, body) },
  }
  let local = '{"local":true}'
  const options = {
    remotePath: '/PCTime/',
    async flush() { calls.push(['flush']) },
    async merge(value) { calls.push(['merge', value]); local = '{"merged":true}' },
    async readUsage() { return local },
    config: { categories: ['其他'], categoryColors: {}, defaultCategory: '其他', rules: [], webdav: { password: 'secret' }, appSettings: { autoLaunch: true } },
  }
  return { client, calls, options, uploads }
}

test('connection test only reads directories, including a not-yet-created target', async () => {
  const calls = []
  const client = { async getDirectoryContents(directory) {
    calls.push(directory)
    if (directory !== '/') throw notFound()
    return []
  } }
  const result = await testWebdavConnection(client, '/backups/PCTime/')
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['/backups/PCTime', '/backups', '/'])
})

test('authentication errors fail connection testing without retrying parents', async () => {
  let calls = 0
  const error = Object.assign(new Error('unauthorized'), { status: 401 })
  await assert.rejects(testWebdavConnection({ async getDirectoryContents() { calls++; throw error } }, '/PCTime'), (received) => received === error)
  assert.equal(calls, 1)
  assert.match(webdavErrorMessage(error), /认证失败/)
})

test('sync flushes, merges remote history into live tracker, and uploads merged data', async () => {
  const harness = syncHarness()
  await syncUsageWithWebdav(harness.client, harness.options)
  assert.deepEqual(harness.calls.map(([name]) => name), ['stat', 'flush', 'get', 'merge', 'flush', 'put', 'put'])
  assert.equal(harness.uploads.get('/PCTime/usage.json'), '{"merged":true}')
  const backup = JSON.parse(harness.uploads.get('/PCTime/config.json'))
  assert.equal(backup.webdav, undefined)
  assert.equal(backup.appSettings, undefined)
  assert.deepEqual(backup.categories, ['其他'])
})

test('invalid remote JSON never reaches merge or overwrites remote files', async () => {
  const harness = syncHarness('broken JSON')
  await assert.rejects(syncUsageWithWebdav(harness.client, harness.options), /JSON/)
  assert.equal(harness.calls.some(([name]) => name === 'merge'), false)
  assert.equal(harness.uploads.size, 0)
})

test('a remote permission failure is not mistaken for an absent file', async () => {
  const harness = syncHarness()
  harness.client.getFileContents = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) }
  await assert.rejects(syncUsageWithWebdav(harness.client, harness.options), /forbidden/)
  assert.equal(harness.uploads.size, 0)
})

test('initial sync creates missing directories and uploads local history', async () => {
  const harness = syncHarness()
  harness.client.stat = async () => { throw notFound() }
  harness.client.getFileContents = async () => { throw notFound() }
  await syncUsageWithWebdav(harness.client, harness.options)
  assert.equal(harness.uploads.get('/PCTime/usage.json'), '{"local":true}')
  assert.equal(harness.calls.some(([name]) => name === 'create'), true)
})

test('remote root and slash normalization do not produce double slashes', () => {
  assert.equal(normalizeRemotePath('/'), '/')
  assert.equal(normalizeRemotePath(''), '/PCTime')
  assert.equal(normalizeRemotePath('PCTime\\history\\'), '/PCTime/history')
})
