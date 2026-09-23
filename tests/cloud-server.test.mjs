import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createCloudServer } from '../server/index.mjs'
import { SESSION_DURATION_MS } from '../server/security.mjs'
import { canonicalApp } from '../server/validation.mjs'

const DATE = '2026-09-23'
const PASSWORD = 'A correct password 42!'
const app = (sourceId, totalMs, sourceName = sourceId) => ({ sourceId, sourceName, totalMs })
const snapshot = (revision, apps, timeZone = 'Asia/Shanghai') => ({ revision, timeZone, apps })

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pctime-cloud-test-'))
  const dbPath = path.join(directory, 'pctime.sqlite')
  let service = createCloudServer({ ...options, dbPath })
  let baseUrl = await service.listen(0)
  t.after(async () => {
    await service.close()
    // Delete only the specific temporary directory created by this test.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('pctime-cloud-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  const api = {
    dbPath,
    get url() { return baseUrl },
    async restart() {
      await service.close()
      service = createCloudServer({ ...options, dbPath })
      baseUrl = await service.listen(0)
    },
    async request(route, { method = 'GET', token, body, headers = {}, raw } = {}) {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(10000),
      })
      return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers }
    },
    async register(email = `${randomUUID()}@example.test`, password = PASSWORD) {
      const result = await api.request('/v1/auth/register', { method: 'POST', body: { email, password } })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      return result.body
    },
    async device(token, overrides = {}) {
      const result = await api.request('/v1/devices', { method: 'POST', token, body: { clientId: randomUUID(), name: 'Desktop', platform: 'windows', timeZone: 'Asia/Shanghai', ...overrides } })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      return result.body.device
    },
    put(token, deviceId, value, date = DATE) { return api.request(`/v1/devices/${deviceId}/days/${date}`, { method: 'PUT', token, body: value }) },
    summary(token, date = DATE, deviceId) { return api.request(`/v1/summary?date=${date}${deviceId ? `&deviceId=${deviceId}` : ''}`, { token }) },
  }
  return api
}

function inspect(dbPath, operation) {
  const database = new DatabaseSync(dbPath)
  try { return operation(database) } finally { database.close() }
}

function streamingRequest(url, { body = [], finish = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    request.setTimeout(5000, () => request.destroy(new Error('Test HTTP timeout')))
    request.on('error', reject)
    for (const chunk of body) request.write(chunk)
    if (finish) request.end()
  })
}

test('accounts normalize email, preserve exact passwords, and use generic credential failures', async (t) => {
  const start = Date.parse('2026-09-23T03:00:00Z')
  const api = await fixture(t, { now: () => start })
  const email = '  Alice@EXAMPLE.test  '
  const password = '  A correct password 42!  '
  const account = await api.register(email, password)
  assert.equal(account.user.email, 'alice@example.test')
  assert.match(account.token, /^[\w-]{43}$/u)
  assert.equal(account.expiresAt, new Date(start + SESSION_DURATION_MS).toISOString())
  assert.deepEqual(Object.keys(account).sort(), ['expiresAt', 'token', 'user'])
  assert.deepEqual((await api.request('/v1/auth/me', { token: account.token })).body.user, account.user)
  const wrong = await api.request('/v1/auth/login', { method: 'POST', body: { email, password: password.trim() } })
  const unknown = await api.request('/v1/auth/login', { method: 'POST', body: { email: 'missing@example.test', password } })
  const duplicate = await api.request('/v1/auth/register', { method: 'POST', body: { email, password } })
  assert.equal(wrong.status, 401)
  assert.deepEqual([unknown.status, unknown.body], [wrong.status, wrong.body])
  assert.deepEqual([duplicate.status, duplicate.body], [wrong.status, wrong.body])
  const login = await api.request('/v1/auth/login', { method: 'POST', body: { email, password } })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, account.user.id)
  assert.notEqual(login.body.token, account.token)
})

test('SQLite retains salted password digests and token hashes, never raw credentials', async (t) => {
  const api = await fixture(t)
  const first = await api.register('first@example.test')
  await api.register('second@example.test')
  inspect(api.dbPath, (db) => {
    const users = db.prepare('SELECT password_hash FROM users').all()
    assert.equal(users.length, 2)
    assert.notEqual(users[0].password_hash, users[1].password_hash)
    for (const user of users) {
      assert.match(user.password_hash, /^scrypt\$32768\$8\$2\$/u)
      assert.equal(user.password_hash.includes(PASSWORD), false)
    }
    const sessions = db.prepare('SELECT * FROM sessions').all()
    assert.equal(JSON.stringify(sessions).includes(first.token), false)
    assert.ok(sessions.some((session) => session.token_hash === createHash('sha256').update(first.token).digest('hex')))
  })
})

test('simultaneous registration cannot create duplicate accounts or lose the successful credential', async (t) => {
  const api = await fixture(t)
  const body = { email: 'race@example.test', password: PASSWORD }
  const results = await Promise.all([
    api.request('/v1/auth/register', { method: 'POST', body }),
    api.request('/v1/auth/register', { method: 'POST', body }),
  ])
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 401])
  const successful = results.find((result) => result.status === 201)
  const login = await api.request('/v1/auth/login', { method: 'POST', body })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, successful.body.user.id)
  inspect(api.dbPath, (db) => assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, 1))
})

test('logout revokes only the current session and expiry applies at the 30-day boundary', async (t) => {
  let now = Date.parse('2026-09-23T00:00:00Z')
  const api = await fixture(t, { now: () => now })
  const account = await api.register('expiry@example.test')
  const login = await api.request('/v1/auth/login', { method: 'POST', body: { email: account.user.email, password: PASSWORD } })
  assert.equal((await api.request('/v1/auth/logout', { method: 'POST', token: account.token })).status, 200)
  assert.equal((await api.request('/v1/auth/me', { token: account.token })).status, 401)
  assert.equal((await api.request('/v1/auth/me', { token: login.body.token })).status, 200)
  now += SESSION_DURATION_MS - 1
  assert.equal((await api.request('/v1/auth/me', { token: login.body.token })).status, 200)
  now += 1
  assert.equal((await api.request('/v1/auth/me', { token: login.body.token })).status, 401)
  assert.equal((await api.request('/v1/auth/me')).status, 401)
  assert.equal((await api.request('/v1/auth/me', { token: 'not-a-token' })).status, 401)
})

test('device IDs are idempotent within accounts and device data remains account-isolated', async (t) => {
  const api = await fixture(t)
  const owner = await api.register()
  const stranger = await api.register()
  const device = await api.device(owner.token, { clientId: 'stable-client' })
  const renamed = await api.device(owner.token, { clientId: 'stable-client', name: 'Renamed laptop', timeZone: 'Europe/London' })
  assert.equal(renamed.id, device.id)
  assert.equal(renamed.name, 'Renamed laptop')
  assert.equal(renamed.timeZone, 'Europe/London')
  const different = await api.device(stranger.token, { clientId: 'stable-client' })
  assert.notEqual(different.id, device.id)
  const mismatch = await api.request('/v1/devices', { method: 'POST', token: owner.token, body: { clientId: 'stable-client', name: 'Phone', platform: 'android', timeZone: 'UTC' } })
  assert.equal(mismatch.status, 409)
  assert.equal((await api.put(owner.token, device.id, snapshot(1, [app('wechat', 600000)]))).status, 200)
  const denied = await api.put(stranger.token, device.id, snapshot(2, []))
  assert.equal(denied.status, 404)
  const nonexistent = await api.put(stranger.token, randomUUID(), snapshot(2, []))
  assert.deepEqual(nonexistent.body, denied.body)
  assert.equal((await api.summary(stranger.token, DATE, device.id)).status, 404)
  const ownDevices = (await api.request('/v1/devices', { token: stranger.token })).body.devices
  assert.deepEqual(ownDevices.map((entry) => entry.id), [different.id])
  assert.equal((await api.summary(stranger.token)).body.totalMs, 0)
})

test('summary sums simultaneous device use and merges only known cross-platform applications', async (t) => {
  const api = await fixture(t)
  const { token } = await api.register()
  const pc = await api.device(token, { name: 'Windows PC' })
  const phone = await api.device(token, { name: 'Android phone', platform: 'android' })
  const unused = await api.device(token, { name: 'Offline tablet', platform: 'android' })
  await api.put(token, pc.id, snapshot(1, [app('WECHAT.EXE', 400000), app('weixin', 200000), app('site:bilibili', 300000), app('QQ.EXE', 100000), app('editor', 70000, 'Editor')]))
  await api.put(token, phone.id, snapshot(1, [app('com.tencent.mm', 600000), app('tv.danmaku.bili', 200000), app('com.tencent.mobileqq', 200000), app('editor', 30000, 'Editor')]))
  const { body } = await api.summary(token)
  assert.equal(body.metric, 'sumDevices')
  assert.equal(body.totalMs, 2100000)
  assert.equal(body.devices.find((entry) => entry.id === unused.id).totalMs, 0)
  assert.deepEqual(body.apps.map((entry) => [entry.canonicalId, entry.totalMs]), [['wechat', 1200000], ['bilibili', 500000], ['qq', 300000], ['windows:editor', 70000], ['android:editor', 30000]])
  assert.equal(body.apps[0].name, '微信')
  assert.deepEqual(body.apps[0].devices.map((entry) => entry.totalMs), [600000, 600000])
  assert.equal(body.devices.reduce((sum, entry) => sum + entry.totalMs, 0), body.totalMs)
  assert.equal(body.apps.reduce((sum, entry) => sum + entry.totalMs, 0), body.totalMs)
  assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T/u)
  const selected = (await api.summary(token, DATE, pc.id)).body
  assert.equal(selected.totalMs, 1070000)
  assert.deepEqual(selected.devices.map((entry) => entry.id), [pc.id])
  assert.ok(selected.apps.every((entry) => entry.devices.length === 1 && entry.devices[0].deviceId === pc.id))
})

test('all specified aliases map by source ID rather than potentially misleading display names', () => {
  for (const id of ['wechat', 'weixin', 'wechat.exe', 'weixin.exe', '微信']) assert.equal(canonicalApp('windows', id.toUpperCase(), 'wrong').canonicalId, 'wechat')
  for (const id of ['bilibili', 'bilibili.exe', '哔哩哔哩', 'site:bilibili']) assert.equal(canonicalApp('windows', id, 'wrong').canonicalId, 'bilibili')
  for (const id of ['qq', 'qq.exe']) assert.equal(canonicalApp('windows', id, 'wrong').canonicalId, 'qq')
  for (const [id, expected] of [['com.tencent.mm', 'wechat'], ['tv.danmaku.bili', 'bilibili'], ['com.tencent.mobileqq', 'qq']]) assert.equal(canonicalApp('android', id, 'wrong').canonicalId, expected)
  assert.equal(canonicalApp('windows', 'another-app', '微信').canonicalId, 'windows:another-app')
  assert.equal(canonicalApp('android', 'wechat', '微信').canonicalId, 'android:wechat')
})

test('daily snapshots replace totals, ignore equal/older revisions, and support concurrent retries and clearing', async (t) => {
  let now = Date.parse('2026-09-23T00:00:00Z')
  const api = await fixture(t, { now: () => now })
  const { token } = await api.register()
  const pc = await api.device(token)
  assert.deepEqual((await api.put(token, pc.id, snapshot(1, [app('editor', 100)]))).body, { accepted: true, revision: 1 })
  assert.deepEqual((await api.put(token, pc.id, snapshot(1, [app('editor', 900)]))).body, { accepted: false, revision: 1 })
  assert.deepEqual((await api.put(token, pc.id, snapshot(5, [app('browser', 500)]))).body, { accepted: true, revision: 5 })
  assert.deepEqual((await api.put(token, pc.id, snapshot(3, [app('editor', 300)]))).body, { accepted: false, revision: 5 })
  const current = (await api.summary(token)).body
  assert.deepEqual(current.apps.map((entry) => entry.canonicalId), ['windows:browser'])
  assert.equal(current.totalMs, 500)
  await Promise.all([api.put(token, pc.id, snapshot(9, [app('editor', 900)])), api.put(token, pc.id, snapshot(8, [app('editor', 800)]))])
  assert.equal((await api.summary(token)).body.totalMs, 900)
  now += 10000
  assert.deepEqual((await api.put(token, pc.id, snapshot(10, []))).body, { accepted: true, revision: 10 })
  const empty = (await api.summary(token)).body
  assert.equal(empty.totalMs, 0)
  assert.deepEqual(empty.apps, [])
  assert.equal(empty.updatedAt, new Date(now).toISOString())
  assert.equal(empty.devices[0].lastSyncedAt, empty.updatedAt)
  assert.deepEqual((await api.put(token, pc.id, snapshot(9, [app('editor', 900)]))).body, { accepted: false, revision: 10 })
})

test('accounts, opaque sessions, revisions, and local-day time zones survive server restart', async (t) => {
  const api = await fixture(t)
  const account = await api.register()
  const phone = await api.device(account.token, { platform: 'android', timeZone: 'Pacific/Honolulu' })
  await api.put(account.token, phone.id, snapshot(7, [app('com.tencent.mm', 12345)], 'Pacific/Honolulu'), '2026-09-22')
  await api.restart()
  assert.equal((await api.request('/v1/auth/me', { token: account.token })).body.user.id, account.user.id)
  assert.equal((await api.summary(account.token, '2026-09-22')).body.totalMs, 12345)
  assert.equal((await api.summary(account.token, '2026-09-23')).body.totalMs, 0)
  assert.deepEqual((await api.put(account.token, phone.id, snapshot(7, []), '2026-09-22')).body, { accepted: false, revision: 7 })
  inspect(api.dbPath, (db) => {
    const row = db.prepare('SELECT time_zone, date FROM days').get()
    assert.equal(row.time_zone, 'Pacific/Honolulu')
    assert.equal(row.date, '2026-09-22')
  })
})

test('a failed replacement rolls back its revision and app rows without leaking database errors', async (t) => {
  const api = await fixture(t)
  const { token } = await api.register()
  const pc = await api.device(token)
  await api.put(token, pc.id, snapshot(1, [app('original', 100)]))
  inspect(api.dbPath, (db) => db.exec("CREATE TRIGGER simulate_write_failure BEFORE INSERT ON daily_apps WHEN NEW.source_id = 'fail' BEGIN SELECT RAISE(ABORT, 'private database failure detail'); END;"))
  const failure = await api.put(token, pc.id, snapshot(2, [app('new', 200), app('fail', 300)]))
  assert.equal(failure.status, 500)
  assert.equal(JSON.stringify(failure.body).includes('private database'), false)
  const summary = (await api.summary(token)).body
  assert.equal(summary.totalMs, 100)
  assert.equal(summary.apps[0].canonicalId, 'windows:original')
  assert.deepEqual((await api.put(token, pc.id, snapshot(1, []))).body, { accepted: false, revision: 1 })
  inspect(api.dbPath, (db) => db.exec('DROP TRIGGER simulate_write_failure'))
  assert.deepEqual((await api.put(token, pc.id, snapshot(2, [app('new', 200)]))).body, { accepted: true, revision: 2 })
})

test('invalid snapshots are rejected before changing the existing day', async (t) => {
  const api = await fixture(t)
  const { token } = await api.register()
  const pc = await api.device(token)
  await api.put(token, pc.id, snapshot(1, [app('editor', 100)]))
  const invalid = [
    null, [], {}, snapshot(0, []), snapshot(1.2, []), snapshot(Number.MAX_SAFE_INTEGER + 1, []),
    snapshot(2, [app('editor', -1)]), snapshot(2, [app('editor', 1.5)]), snapshot(2, [app('editor', null)]),
    snapshot(2, [app('editor', 45000000), app('browser', 45000001)]),
    snapshot(2, [app('EDITOR', 1), app('editor', 2)]),
    snapshot(2, [app('a'.repeat(257), 1)]), snapshot(2, [app('id', 1, 'a'.repeat(201))]),
    snapshot(2, [app('editor', 1)], 'Mars/Olympus'), snapshot(2, [], '+08:00'),
    snapshot(2, Array.from({ length: 2001 }, (_, index) => app(`app-${index}`, 0))),
    { ...snapshot(2, []), windows: [{ title: 'private browsing title' }] },
    snapshot(2, [{ ...app('editor', 1), title: 'not allowed' }]),
  ]
  for (const value of invalid) assert.equal((await api.put(token, pc.id, value)).status, 400, JSON.stringify(value).slice(0, 120))
  for (const date of ['2026-02-30', '2026-9-23', 'not-a-date']) assert.equal((await api.put(token, pc.id, snapshot(2, []), date)).status, 400)
  assert.equal((await api.summary(token)).body.totalMs, 100)
  assert.equal((await api.request('/v1/summary?date=2026-09-23&date=2026-09-22', { token })).status, 400)
  assert.equal((await api.request('/v1/summary?date=2026-09-23&deviceId=', { token })).status, 400)
  assert.equal((await api.request('/v1/summary?date=2026-09-23&other=private', { token })).status, 400)
})

test('25-hour DST days and exactly 2000 unique apps are valid while totals still sum across devices', async (t) => {
  const api = await fixture(t)
  const { token } = await api.register()
  const first = await api.device(token)
  const second = await api.device(token, { platform: 'android' })
  const apps = Array.from({ length: 2000 }, (_, index) => app(`application-${index}`, index === 0 ? 90000000 : 0))
  assert.equal((await api.put(token, first.id, snapshot(1, apps, 'America/New_York'))).status, 200)
  assert.equal((await api.put(token, second.id, snapshot(1, [app('phone-app', 90000000)]))).status, 200)
  assert.equal((await api.summary(token)).body.totalMs, 180000000)
})

test('JSON body limits cover declared and chunked bodies, malformed encodings, and slow requests', async (t) => {
  const api = await fixture(t, { maxBodyBytes: 1024, bodyTimeoutMs: 80 })
  const large = await api.request('/v1/auth/register', { method: 'POST', body: { email: 'large@example.test', password: 'x'.repeat(2048) } })
  assert.equal(large.status, 413)
  const chunked = await streamingRequest(`${api.url}/v1/auth/register`, { body: ['{"password":"', 'x'.repeat(2048), '"}'] })
  assert.equal(chunked.status, 413)
  assert.equal((await api.request('/v1/auth/register', { method: 'POST', raw: '{broken' })).status, 400)
  assert.equal((await api.request('/v1/auth/register', { method: 'POST', raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await api.request('/v1/auth/register', { method: 'POST', raw: '{}', headers: { 'Content-Encoding': 'gzip' } })).status, 415)
  const invalidUtf8 = await streamingRequest(`${api.url}/v1/auth/register`, { body: [Buffer.from([0xff, 0xfe])] })
  assert.equal(invalidUtf8.status, 400)
  const slow = await streamingRequest(`${api.url}/v1/auth/register`, { body: ['{'], finish: false })
  assert.equal(slow.status, 408)
})

test('a disconnected upload does not crash the listener or create an account', async (t) => {
  const api = await fixture(t)
  await new Promise((resolve) => {
    const request = http.request(`${api.url}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    request.on('error', () => {})
    request.write('{"email":"aborted@example.test",')
    setTimeout(() => { request.destroy(); resolve() }, 25)
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await api.request('/healthz')).status, 200)
  inspect(api.dbPath, (db) => assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, 0))
})

test('CORS is denied by default and explicit origins receive only narrow preflight permissions', async (t) => {
  const closed = await fixture(t)
  const blocked = await closed.request('/v1/auth/register', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: { email: 'test@example.test', password: PASSWORD } })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.headers.get('access-control-allow-origin'), null)
  inspect(closed.dbPath, (db) => assert.equal(db.prepare('SELECT count(*) AS count FROM users').get().count, 0))
  const allowed = await fixture(t, { allowedOrigins: ['http://127.0.0.1:5173'] })
  const preflight = await allowed.request('/v1/auth/login', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
  assert.equal((await allowed.request('/healthz', { headers: { Origin: 'http://127.0.0.1:5173.evil.example' } })).status, 403)
  assert.equal((await allowed.request('/healthz', { headers: { Origin: 'null' } })).status, 403)
  assert.equal((await allowed.request('/healthz')).status, 200)
  assert.throws(() => createCloudServer({ dbPath: ':memory:', allowedOrigins: ['*'] }))
})

test('request rate limits expire and cannot be bypassed by forwarding headers', async (t) => {
  let now = Date.now()
  const api = await fixture(t, { now: () => now, rateLimits: { requests: 2 } })
  assert.equal((await api.request('/healthz')).status, 200)
  assert.equal((await api.request('/healthz')).status, 200)
  const limited = await api.request('/healthz', { headers: { 'X-Forwarded-For': '198.51.100.7' } })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  now += 60001
  assert.equal((await api.request('/healthz')).status, 200)
})

test('auth rate limiting counts unknown accounts and normalized emails independently of account existence', async (t) => {
  let now = Date.now()
  const api = await fixture(t, { now: () => now, rateLimits: { authIp: 20, authEmail: 2 } })
  const login = (email) => api.request('/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } })
  assert.equal((await login('missing@example.test')).status, 401)
  assert.equal((await login('MISSING@EXAMPLE.test')).status, 401)
  assert.equal((await login(' missing@example.test ')).status, 429)
  now += 15 * 60000 + 1
  assert.equal((await login('missing@example.test')).status, 401)
  const ipLimited = await fixture(t, { rateLimits: { authIp: 1, authEmail: 10 } })
  const first = await ipLimited.request('/v1/auth/login', { method: 'POST', body: { email: 'a@example.test', password: PASSWORD } })
  const second = await ipLimited.request('/v1/auth/login', { method: 'POST', body: { email: 'b@example.test', password: PASSWORD } })
  assert.equal(first.status, 401)
  assert.equal(second.status, 429)
})

test('credential and device validation reject invalid input without persisting partial records', async (t) => {
  const api = await fixture(t)
  for (const value of [null, [], {}, { email: 'bad', password: PASSWORD }, { email: 'ok@example.test', password: 'short' }, { email: 'ok@example.test', password: 'x'.repeat(129) }, { email: 'ok@example.test', password: PASSWORD, token: 'injected' }]) {
    assert.equal((await api.request('/v1/auth/register', { method: 'POST', body: value })).status, 400)
  }
  const { token } = await api.register()
  const valid = { clientId: 'client', name: 'PC', platform: 'windows', timeZone: 'UTC' }
  for (const value of [{ ...valid, platform: 'ios' }, { ...valid, timeZone: 'invalid/zone' }, { ...valid, name: '' }, { ...valid, clientId: 'x'.repeat(129) }, { ...valid, userId: 'other-account' }]) {
    assert.equal((await api.request('/v1/devices', { method: 'POST', token, body: value })).status, 400)
  }
  assert.deepEqual((await api.request('/v1/devices', { token })).body.devices, [])
})
