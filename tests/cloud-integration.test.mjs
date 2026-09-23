import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { createCloudServer } from '../server/index.mjs'

// Execute the production Windows modules without booting Electron. The HTTP
// transport, server, SQLite database, journal, and session files are all real.
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

// Only a stand-in for the OS safeStorage boundary; production uses DPAPI.
const encryption = { available: () => true, encrypt: value => Buffer.from(`test:${value}`).reverse(), decrypt: value => Buffer.from(value).reverse().toString().slice(5) }

test('Windows journal and real cloud server merge Android usage without double counting across retry and restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pctime-cloud-integration-'))
  const server = createCloudServer({ dbPath: path.join(directory, 'cloud.sqlite') })
  const services = []
  t.after(async () => {
    for (const service of services) await service.stop()
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })
  const origin = await server.listen(0)
  const module = await load('cloudService')
  await module.evaluate()
  const { createCloudService } = module.namespace
  const options = { directory, encryption, timeZone: () => 'Asia/Shanghai' }
  const windows = await createCloudService(options)
  services.push(windows)

  const date = '2026-09-23'
  const start = new Date(2026, 8, 23, 12).getTime()
  windows.record('Weixin.exe', 'private conversation', start, start + 1000)
  windows.record('Google Chrome', 'private video_哔哩哔哩_bilibili - Google Chrome', start + 1000, start + 2000)
  assert.equal(windows.getState().user, null)
  const credentials = { email: 'integration@example.com', password: 'integration-password-123' }
  const login = await windows.authenticate({ ...credentials, serverUrl: origin, mode: 'register', deviceName: 'Windows PC' })
  assert.equal(login.error, null)
  assert.equal(login.device.platform, 'windows')
  const windowsId = login.device.id
  const clientId = login.device.clientId
  assert.equal((await windows.getSummary(date)).totalMs, 2000)

  const request = async (pathname, { method = 'GET', body, token } = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(response.ok, true, `${method} ${pathname} should succeed (${response.status})`)
    return response.json()
  }
  const androidSession = await request('/v1/auth/login', { method: 'POST', body: credentials })
  const token = androidSession.token
  const { device: android } = await request('/v1/devices', {
    method: 'POST', token, body: { clientId: randomUUID(), name: 'Android phone', platform: 'android', timeZone: 'Asia/Shanghai' },
  })
  const androidSnapshot = { revision: 1, timeZone: 'Asia/Shanghai', apps: [
    { sourceId: 'com.tencent.mm', sourceName: '微信', totalMs: 2000 },
    { sourceId: 'tv.danmaku.bili', sourceName: '哔哩哔哩', totalMs: 3000 },
  ] }
  assert.deepEqual(await request(`/v1/devices/${android.id}/days/${date}`, { method: 'PUT', token, body: androidSnapshot }), { accepted: true, revision: 1 })
  assert.deepEqual(await request(`/v1/devices/${android.id}/days/${date}`, { method: 'PUT', token, body: androidSnapshot }), { accepted: false, revision: 1 })

  const summary = await windows.getSummary(date)
  assert.equal(summary.metric, 'sumDevices')
  assert.equal(summary.totalMs, 7000)
  assert.equal(summary.devices.length, 2)
  assert.equal(summary.apps.length, 2)
  const wechat = summary.apps.find(app => app.canonicalId === 'wechat')
  const bilibili = summary.apps.find(app => app.canonicalId === 'bilibili')
  assert.equal(wechat.totalMs, 3000)
  assert.equal(bilibili.totalMs, 4000)
  assert.equal(wechat.devices.length, 2)
  assert.equal(bilibili.devices.length, 2)
  assert.equal((await windows.getSummary(date, windowsId)).totalMs, 2000)
  assert.equal((await windows.getSummary(date, android.id)).totalMs, 5000)
  for (const app of (await windows.getSummary(date, android.id)).apps) assert.equal(app.devices[0].deviceId, android.id)

  await windows.syncNow()
  assert.equal((await windows.getSummary(date)).totalMs, 7000)
  await windows.stop()
  const restarted = await createCloudService(options)
  services.push(restarted)
  assert.equal(restarted.getState().device.clientId, clientId)
  assert.equal(restarted.getState().device.id, windowsId)
  assert.equal((await restarted.syncNow()).error, null)
  assert.equal((await restarted.getSummary(date)).totalMs, 7000)
  restarted.record('WeChat', 'another private conversation', start + 2000, start + 3000)
  assert.equal((await restarted.syncNow()).error, null)
  const updated = await restarted.getSummary(date)
  assert.equal(updated.totalMs, 8000)
  assert.equal(updated.apps.find(app => app.canonicalId === 'wechat').totalMs, 4000)
  assert.equal(updated.devices.length, 2)

  const sessionPath = path.join(directory, 'cloud-session.json')
  const persisted = JSON.parse(await readFile(sessionPath, 'utf8'))
  const session = JSON.parse(encryption.decrypt(Buffer.from(persisted.encrypted, 'base64')))
  assert.equal((await restarted.logout()).error, null)
  assert.equal(restarted.getState().user, null)
  assert.equal((await fetch(`${origin}/v1/auth/me`, { headers: { authorization: `Bearer ${session.token}` } })).status, 401)
  assert.equal((await request('/v1/auth/me', { token })).user.id, login.user.id)
  assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).encrypted, undefined)
  const journal = await readFile(path.join(directory, 'device-usage.json'), 'utf8')
  assert.equal(journal.includes('private'), false)
  assert.equal(journal.includes(credentials.password), false)
  assert.equal(journal.includes(session.token), false)
})
