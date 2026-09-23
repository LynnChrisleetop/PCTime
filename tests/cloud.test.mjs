import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const context = vm.createContext({ console, Buffer, URL, Date, Intl, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, fetch, structuredClone })
const modules = new Map()
async function load(name) {
  if (modules.has(name)) return modules.get(name)
  const source = await readFile(new URL(`../electron/${name}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
  const module = new vm.SourceTextModule(compiled.outputText, { context })
  modules.set(name, module)
  await module.link(async specifier => {
    if (specifier.startsWith('./')) return load(specifier.slice(2))
    const dependency = await import(specifier)
    return new vm.SyntheticModule(Object.keys(dependency), function () {
      for (const [key, value] of Object.entries(dependency)) this.setExport(key, value)
    }, { context })
  })
  return module
}
async function api(name) { const module = await load(name); if (module.status !== 'evaluated') await module.evaluate(); return module.namespace }
const temporary = async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pctime-cloud-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const encryption = { available: () => true, encrypt: value => Buffer.from(`encrypted:${value}`).reverse(), decrypt: value => Buffer.from(value).reverse().toString().slice(10) }
const authInput = { serverUrl: 'https://screen.example', email: 'person@example.com', password: 'correct-password', mode: 'login', deviceName: 'My PC' }
const user = { id: 'user-1', email: authInput.email }
const device = { id: 'device-1', clientId: 'client', name: 'My PC', platform: 'windows', timeZone: 'Asia/Shanghai', lastSyncedAt: null }
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const authResponse = () => response({ token: 'secret-session-token', expiresAt: '2099-01-01T00:00:00.000Z', user })

test('device journal starts independently of old WebDAV history and never stores window titles', async t => {
  const directory = await temporary(t)
  await writeFile(path.join(directory, 'usage.json'), JSON.stringify({ dates: { '2026-09-23': { privateTitle: 99999 } } }))
  const { createDeviceJournal } = await api('cloudJournal')
  const journal = await createDeviceJournal(directory, () => 'Asia/Shanghai')
  assert.equal(journal.snapshots().length, 0)
  const start = new Date(2026, 8, 23, 12).getTime()
  journal.record('Microsoft Edge', 'secret-document_哔哩哔哩_bilibili', start, start + 1000)
  await journal.flush()
  const snapshot = journal.snapshots()[0]
  assert.equal(snapshot.apps[0].sourceId, 'site:bilibili')
  assert.equal(snapshot.apps[0].totalMs, 1000)
  const disk = await readFile(path.join(directory, 'device-usage.json'), 'utf8')
  assert.equal(disk.includes('secret-document'), false)
  assert.equal(disk.includes('privateTitle'), false)
})

test('journal revisions and stable client identity survive restart and midnight splits', async t => {
  const directory = await temporary(t)
  const { createDeviceJournal } = await api('cloudJournal')
  const first = await createDeviceJournal(directory, () => 'Asia/Shanghai')
  const midnight = new Date(2026, 8, 24).getTime()
  first.record('Weixin', 'secret conversation', midnight - 500, midnight + 500)
  await first.flush()
  const before = first.snapshots()
  assert.equal(before.length, 2)
  assert.equal(before[0].apps[0].totalMs, 500)
  assert.equal(before[1].apps[0].totalMs, 500)
  const second = await createDeviceJournal(directory, () => 'Asia/Shanghai')
  assert.equal(second.clientId, first.clientId)
  second.record('微信', '', midnight + 500, midnight + 1500)
  await second.flush()
  assert.ok(second.snapshots()[1].revision > before[1].revision)
  assert.equal(second.snapshots()[1].apps[0].totalMs, 1500)
})

test('cloud origins reject insecure public hosts and embedded credentials', async () => {
  const { validateServerOrigin } = await api('cloudService')
  for (const bad of ['http://example.com', 'https://u:p@example.com', 'https://example.com/api', 'https://example.com/?x=1']) assert.throws(() => validateServerOrigin(bad))
  for (const good of ['https://example.com', 'http://127.0.0.1:8080', 'http://192.168.1.12:8080', 'http://[::1]:8080']) assert.equal(validateServerOrigin(good), good)
})

test('Bilibili browser attribution requires a recognizable site brand rather than a search keyword', async () => {
  const { sourceForWindow } = await api('cloudJournal')
  for (const title of ['视频名_哔哩哔哩_bilibili - Google Chrome', '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', '视频名 - 哔哩哔哩']) {
    assert.equal(sourceForWindow('Google Chrome', title).sourceId, 'site:bilibili')
  }
  for (const title of ['哔哩哔哩 - 百度搜索', 'GitHub - bilibili project', 'bilibili - Google 搜索', 'Notes mentioning 哔哩哔哩 in a paragraph']) {
    assert.equal(sourceForWindow('Google Chrome', title).sourceId, 'google chrome')
  }
  assert.equal(sourceForWindow('Weixin.exe', 'secret').sourceId, 'wechat')
  assert.equal(sourceForWindow('WeChat', 'secret').sourceId, 'wechat')
  assert.equal(sourceForWindow('哔哩哔哩', 'secret').sourceId, 'bilibili')
})

test('offline uploads retry the same persisted revision and accepted unchanged days are skipped', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  const uploads = []
  let offline = true
  const service = await createCloudService({ directory, encryption, fetch: async (url, options) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/login')) return authResponse()
    if (pathname === '/v1/devices') return response({ device: { ...device, clientId: JSON.parse(options.body).clientId } })
    if (pathname === '/v1/auth/me') return response({ user })
    if (options.method === 'PUT') {
      uploads.push(JSON.parse(options.body))
      const disk = JSON.parse(await readFile(path.join(directory, 'device-usage.json'), 'utf8'))
      assert.ok(disk.days['2026-09-23'].revision >= uploads.at(-1).revision)
      if (offline) throw new Error('offline')
      return response({ accepted: true, revision: uploads.at(-1).revision })
    }
    return response({ ok: true })
  } })
  t.after(() => service.stop())
  const start = new Date(2026, 8, 23, 12).getTime()
  service.record('WeChat', 'private conversation', start, start + 1000)
  assert.equal(uploads.length, 0)
  await service.authenticate(authInput)
  await service.syncNow()
  assert.ok(service.getState().error)
  offline = false
  await service.syncNow()
  assert.equal(service.getState().error, null)
  assert.equal(uploads[0].revision, uploads.at(-1).revision)
  const count = uploads.length
  await service.syncNow()
  assert.equal(uploads.length, count)
  const disk = await readFile(path.join(directory, 'cloud-session.json'), 'utf8')
  assert.equal(disk.includes('secret-session-token'), false)
  assert.equal(disk.includes(authInput.password), false)
  assert.equal(JSON.stringify(uploads).includes('private conversation'), false)
})

test('logout aborts an in-flight upload and a late response cannot restore the account', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  let finishUpload
  let uploadSignal
  const service = await createCloudService({ directory, encryption, fetch: async (url, options) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/login')) return authResponse()
    if (pathname === '/v1/devices') return response({ device: { ...device, clientId: JSON.parse(options.body).clientId } })
    if (pathname === '/v1/auth/me') return response({ user })
    if (options.method === 'PUT') {
      uploadSignal = options.signal
      return new Promise(resolve => { finishUpload = () => resolve(response({ accepted: true, revision: 1 })) })
    }
    return response({ ok: true })
  } })
  t.after(() => service.stop())
  await service.authenticate(authInput)
  const start = new Date(2026, 8, 23, 12).getTime()
  service.record('Editor', '', start, start + 1000)
  const syncing = service.syncNow()
  while (!finishUpload) await new Promise(resolve => setImmediate(resolve))
  const loggedOut = service.logout()
  assert.equal(uploadSignal.aborted, true)
  finishUpload()
  await Promise.all([syncing, loggedOut])
  assert.equal(service.getState().user, null)
  assert.equal(service.getState().syncing, false)
  assert.equal((await readFile(path.join(directory, 'cloud-session.json'), 'utf8')).includes('encrypted'), false)
})

test('restarting restores the encrypted session and skips already accepted daily snapshots', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  let uploads = 0
  const clientIds = []
  const transport = async (url, options) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/login')) return authResponse()
    if (pathname === '/v1/auth/me') return response({ user })
    if (pathname === '/v1/devices') {
      const clientId = JSON.parse(options.body).clientId
      clientIds.push(clientId)
      return response({ device: { ...device, clientId } })
    }
    if (options.method === 'PUT') { uploads++; return response({ accepted: true, revision: JSON.parse(options.body).revision }) }
    return response({ ok: true })
  }
  const first = await createCloudService({ directory, encryption, fetch: transport })
  const start = new Date(2026, 8, 23, 12).getTime()
  first.record('QQ', '', start, start + 1000)
  await first.authenticate(authInput)
  await first.stop()
  const second = await createCloudService({ directory, encryption, fetch: transport })
  t.after(() => second.stop())
  assert.equal(second.getState().user.id, user.id)
  await second.syncNow()
  assert.equal(uploads, 1)
  assert.equal(new Set(clientIds).size, 1)
})

test('401 responses clear the local session and stop further uploads', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  let expired = false
  let requests = 0
  const service = await createCloudService({ directory, encryption, fetch: async (url, options) => {
    requests++
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/login')) return authResponse()
    if (pathname === '/v1/auth/me') return expired ? response({ error: 'expired' }, 401) : response({ user })
    if (pathname === '/v1/devices') return response({ device: { ...device, clientId: JSON.parse(options.body).clientId } })
    return response({ ok: true })
  } })
  t.after(() => service.stop())
  await service.authenticate(authInput)
  expired = true
  await service.syncNow()
  assert.equal(service.getState().user, null)
  assert.match(service.getState().error, /登录/)
  const count = requests
  await service.syncNow()
  assert.equal(requests, count)
  assert.equal((await readFile(path.join(directory, 'cloud-session.json'), 'utf8')).includes('encrypted'), false)
})

test('a new login cancels older account work and only the new account receives subsequent snapshots', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  let finishOld
  let oldSignal
  let deferOld = true
  const uploads = []
  const service = await createCloudService({ directory, encryption, fetch: async (url, options) => {
    const pathname = new URL(url).pathname
    const second = options.headers.Authorization === 'Bearer token-two'
    const currentUser = second ? { id: 'user-2', email: 'two@example.com' } : user
    if (pathname.endsWith('/login')) return JSON.parse(options.body).email === 'two@example.com'
      ? response({ token: 'token-two', expiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'user-2', email: 'two@example.com' } }) : authResponse()
    if (pathname === '/v1/auth/me') return response({ user: currentUser })
    if (pathname === '/v1/devices') return response({ device: { ...device, id: second ? 'device-2' : 'device-1', clientId: JSON.parse(options.body).clientId } })
    if (options.method === 'PUT') {
      uploads.push([pathname, options.headers.Authorization])
      if (!second && deferOld) {
        oldSignal = options.signal
        return new Promise(resolve => { finishOld = () => resolve(response({ accepted: true, revision: JSON.parse(options.body).revision })) })
      }
      return response({ accepted: true, revision: JSON.parse(options.body).revision })
    }
    return response({ ok: true })
  } })
  t.after(() => service.stop())
  await service.authenticate(authInput)
  const start = new Date(2026, 8, 23, 12).getTime()
  service.record('Weixin.exe', 'private', start, start + 1000)
  const oldSync = service.syncNow()
  while (!finishOld) await new Promise(resolve => setImmediate(resolve))
  const newLogin = service.authenticate({ ...authInput, email: 'two@example.com' })
  assert.equal(oldSignal.aborted, true)
  deferOld = false
  finishOld()
  await Promise.all([oldSync, newLogin])
  assert.equal(service.getState().user.id, 'user-2')
  assert.equal(service.getState().error, null)
  assert.match(uploads.at(-1)[0], /device-2/)
  assert.equal(uploads.at(-1)[1], 'Bearer token-two')
})

test('login refuses to transmit credentials when safeStorage is unavailable', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  let requests = 0
  const service = await createCloudService({ directory, encryption: { ...encryption, available: () => false }, fetch: async () => { requests++; return authResponse() } })
  t.after(() => service.stop())
  const result = await service.authenticate(authInput)
  assert.equal(result.user, null)
  assert.match(result.error, /安全存储/)
  assert.equal(requests, 0)
})

test('offline logout clears credentials locally and explains delayed remote revocation', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  const service = await createCloudService({ directory, encryption, fetch: async (url, options) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/login')) return authResponse()
    if (pathname === '/v1/auth/me') return response({ user })
    if (pathname === '/v1/devices') return response({ device: { ...device, clientId: JSON.parse(options.body).clientId } })
    throw new Error('offline')
  } })
  t.after(() => service.stop())
  await service.authenticate(authInput)
  const state = await service.logout()
  assert.equal(state.user, null)
  assert.match(state.error, /本机已退出/)
  assert.equal((await readFile(path.join(directory, 'cloud-session.json'), 'utf8')).includes('encrypted'), false)
})

test('invalid nested cloud summaries fail safely before reaching the renderer', async t => {
  const directory = await temporary(t)
  const { createCloudService } = await api('cloudService')
  const valid = { date: '2026-09-23', metric: 'sumDevices', totalMs: 1000, updatedAt: null,
    devices: [{ ...device, totalMs: 1000 }],
    apps: [{ canonicalId: 'wechat', name: '微信', totalMs: 1000, devices: [{ deviceId: device.id, name: device.name, platform: 'windows', totalMs: 1000 }] }],
  }
  let summary = valid
  const service = await createCloudService({ directory, encryption, fetch: async (url, options) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/login')) return authResponse()
    if (pathname === '/v1/auth/me') return response({ user })
    if (pathname === '/v1/devices') return response({ device: { ...device, clientId: JSON.parse(options.body).clientId } })
    return response(summary)
  } })
  t.after(() => service.stop())
  await service.authenticate(authInput)
  for (const invalid of [
    { ...valid, apps: [null] },
    { ...valid, devices: [{ ...device, totalMs: -1 }] },
    { ...valid, apps: [{ ...valid.apps[0], devices: [null] }] },
    { ...valid, updatedAt: {} },
  ]) {
    summary = invalid
    await assert.rejects(service.getSummary(valid.date), /格式无效/)
    assert.equal(service.getState().user.id, user.id)
  }
  summary = valid
  assert.equal((await service.getSummary(valid.date)).apps[0].devices[0].totalMs, 1000)
})
