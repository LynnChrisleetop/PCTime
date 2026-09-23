import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test, afterEach } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/cloud.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } })
const { normalizeServerUrl, createBrowserCloudApi, demoCloudSummary, validateCloudSummary } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const credentials = { serverUrl: 'http://127.0.0.1:4318', email: 'person@example.com', password: 'valid-password', mode: 'login', deviceName: 'unused' }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('cloud addresses reject public cleartext, embedded credentials, paths and non-HTTP schemes', () => {
  for (const input of ['http://time.example.com', 'https://user:secret@time.example.com', 'https://time.example.com/v1', 'https://time.example.com?key=secret', 'file:///private', 'javascript:alert(1)', 'http://192.168.999.1', 'http://172.32.0.1']) {
    assert.throws(() => normalizeServerUrl(input), undefined, input)
  }
  for (const input of ['https://time.example.com', 'http://127.0.0.1:4318', 'http://192.168.1.2:4318', 'http://10.1.2.3', 'http://172.16.0.1', 'http://[::1]:4318']) {
    assert.equal(normalizeServerUrl(`${input}/`), input)
  }
})

test('browser session stays in memory, does not register/upload a phantom device, and revokes on logout', async () => {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return response(url.endsWith('/login') ? { token: 'private-token', user: { id: 'u1', email: credentials.email } }
      : url.includes('/summary?') ? demoCloudSummary('2026-09-23') : { ok: true })
  }
  const client = createBrowserCloudApi()
  await client.authenticate(credentials)
  const state = await client.getState()
  assert.equal(state.user.id, 'u1')
  assert.equal(state.device, null)
  assert.ok(!JSON.stringify(state).includes('private-token'))
  assert.equal((await createBrowserCloudApi().getState()).user, null)
  await client.syncNow()
  await client.getSummary('2026-09-23', 'demo-pc')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].url.endsWith('date=2026-09-23&deviceId=demo-pc'))
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-token')
  assert.equal(calls[1].options.redirect, 'error')
  assert.equal(calls[1].options.credentials, 'omit')
  await client.logout()
  assert.equal((await client.getState()).user, null)
  assert.ok(calls[2].url.endsWith('/logout'))
  await assert.rejects(client.getSummary('2026-09-23'), /请先登录/)
})

test('a late login cannot recreate a session after logout and is revoked', async () => {
  let finishLogin
  let revoked = false
  globalThis.fetch = async (url) => url.endsWith('/login')
    ? new Promise((resolve) => { finishLogin = resolve })
    : (revoked = true, response({ ok: true }))
  const client = createBrowserCloudApi()
  const pending = client.authenticate(credentials)
  await client.logout()
  finishLogin(response({ token: 'late-token', user: { id: 'u1', email: credentials.email } }))
  await pending
  assert.equal((await client.getState()).user, null)
  assert.equal(revoked, true)
})

test('expired sessions clear account state and do not expose a previous summary', async () => {
  globalThis.fetch = async (url) => response(url.endsWith('/login')
    ? { token: 'token', user: { id: 'u1', email: credentials.email } } : { error: '登录已过期' }, url.endsWith('/login') ? 200 : 401)
  const client = createBrowserCloudApi()
  await client.authenticate(credentials)
  await assert.rejects(client.getSummary('2026-09-23'), /登录已过期/)
  assert.equal((await client.getState()).user, null)
})

test('offline logout removes local credentials even when server revocation fails', async () => {
  globalThis.fetch = async () => response({ token: 'token', user: { id: 'u1', email: credentials.email } })
  const client = createBrowserCloudApi()
  await client.authenticate(credentials)
  globalThis.fetch = async () => { throw new TypeError('Network unavailable') }
  const state = await client.logout()
  assert.equal(state.user, null)
  assert.match(state.error, /本页已退出/)
})

test('cross-device preview totals reconcile with both devices and canonical applications', () => {
  const all = demoCloudSummary('2026-09-23')
  assert.equal(all.metric, 'sumDevices')
  assert.equal(all.totalMs, all.devices.reduce((sum, d) => sum + d.totalMs, 0))
  assert.equal(all.totalMs, all.apps.reduce((sum, a) => sum + a.totalMs, 0))
  assert.equal(all.apps.find((a) => a.canonicalId === 'wechat').totalMs, 4980000)
  for (const device of all.devices) {
    const filtered = demoCloudSummary('2026-09-23', device.id)
    assert.equal(filtered.totalMs, device.totalMs)
    assert.equal(filtered.devices.length, 1)
    assert.ok(filtered.apps.every((app) => app.devices.every((d) => d.deviceId === device.id)))
  }
})

test('malformed nested app/device responses fail visibly instead of crashing the dashboard', () => {
  const valid = demoCloudSummary('2026-09-23')
  assert.deepEqual(validateCloudSummary(valid, valid.date), valid)
  for (const invalid of [
    { ...valid, date: '2026-09-22' }, { ...valid, totalMs: -1 },
    { ...valid, apps: [null] }, { ...valid, devices: [null] },
    { ...valid, apps: [{ ...valid.apps[0], devices: [null] }] },
    { ...valid, apps: [{ ...valid.apps[0], totalMs: '1234' }] },
  ]) assert.throws(() => validateCloudSummary(invalid, valid.date), /统计格式无效/)
})

test('a server response cannot consume unbounded browser memory', async () => {
  globalThis.fetch = async () => response({ payload: 'x'.repeat(2 * 1024 * 1024) })
  await assert.rejects(createBrowserCloudApi().authenticate(credentials), /响应过大/)
})
