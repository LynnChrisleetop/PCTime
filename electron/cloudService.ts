import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { createDeviceJournal } from './cloudJournal'

export type CloudDevice = { id: string; clientId: string; name: string; platform: 'windows' | 'android'; timeZone: string; lastSyncedAt: string | null }
export type CloudState = { serverUrl: string; user: { id: string; email: string } | null; device: CloudDevice | null; syncing: boolean; lastSyncedAt: string | null; error: string | null }
export type CloudSummary = {
  date: string; metric: 'sumDevices'; totalMs: number; updatedAt: string | null
  devices: Array<CloudDevice & { totalMs: number }>
  apps: Array<{ canonicalId: string; name: string; totalMs: number; devices: Array<{ deviceId: string; name: string; platform: 'windows' | 'android'; totalMs: number }> }>
}
export type CloudAuthentication = { serverUrl: string; email: string; password: string; mode: 'login' | 'register'; deviceName: string }
type Session = { token: string; expiresAt: string; user: NonNullable<CloudState['user']>; device: CloudDevice | null; serverUrl: string; deviceName: string; lastSyncedAt: string | null }
type Encryption = { available: () => boolean; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string }
class CloudError extends Error {
  constructor(message: string, readonly status = 0) { super(message) }
}
class Cancelled extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 }

export function validateServerOrigin(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new CloudError('请输入完整的服务地址。') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new CloudError('服务地址只填写域名和端口，不包含路径、账号或参数。')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const parts = host.split('.').map(Number)
  const local = host === 'localhost' || host === '::1' ||
    (isIP(host) === 4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))) ||
    (isIP(host) === 6 && /^f[cd][\da-f]{2}:/i.test(host))
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new CloudError('公网服务必须使用 HTTPS；HTTP 仅支持本机或私有局域网地址。')
  return url.origin
}

function deviceFrom(value: unknown): CloudDevice {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.clientId) || !nonempty(value.name) ||
    !nonempty(value.timeZone) || (value.platform !== 'windows' && value.platform !== 'android') ||
    (value.lastSyncedAt !== null && typeof value.lastSyncedAt !== 'string')) throw new CloudError('服务返回了无效的设备信息。')
  return { id: value.id, clientId: value.clientId, name: value.name, platform: value.platform, timeZone: value.timeZone, lastSyncedAt: value.lastSyncedAt }
}

function summaryFrom(value: unknown, date: string): CloudSummary {
  const duration = (ms: unknown): ms is number => Number.isSafeInteger(ms) && Number(ms) >= 0
  const invalid = () => new CloudError('统计响应格式无效。')
  if (!record(value) || value.metric !== 'sumDevices' || value.date !== date || !duration(value.totalMs) ||
    !Array.isArray(value.devices) || !Array.isArray(value.apps) ||
    (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))))) throw invalid()
  const devices = value.devices.map(item => {
    if (!record(item) || !duration(item.totalMs)) throw invalid()
    try { return { ...deviceFrom(item), totalMs: item.totalMs } } catch { throw invalid() }
  })
  const apps = value.apps.map(item => {
    if (!record(item) || !nonempty(item.canonicalId) || !nonempty(item.name) || !duration(item.totalMs) || !Array.isArray(item.devices)) throw invalid()
    const contributors = item.devices.map((contributor): CloudSummary['apps'][number]['devices'][number] => {
      if (!record(contributor) || !nonempty(contributor.deviceId) || !nonempty(contributor.name) ||
        (contributor.platform !== 'windows' && contributor.platform !== 'android') || !duration(contributor.totalMs)) throw invalid()
      return { deviceId: contributor.deviceId, name: contributor.name, platform: contributor.platform, totalMs: contributor.totalMs }
    })
    return { canonicalId: item.canonicalId, name: item.name, totalMs: item.totalMs, devices: contributors }
  })
  return { date, metric: 'sumDevices', totalMs: value.totalMs, devices, apps, updatedAt: value.updatedAt }
}

export async function createCloudService(options: {
  directory: string; encryption: Encryption; fetch?: typeof fetch; timeZone?: () => string
}) {
  const journal = await createDeviceJournal(options.directory, options.timeZone)
  const transport = options.fetch ?? fetch
  const filename = path.join(options.directory, 'cloud-session.json')
  const state: CloudState = { serverUrl: '', user: null, device: null, syncing: false, lastSyncedAt: null, error: null }
  let session: Session | null = null
  let epoch = 0
  let stopped = false
  let controller: AbortController | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let pendingSync: Promise<CloudState> | null = null
  let syncTimer: ReturnType<typeof setInterval> | undefined
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => undefined)
    return result
  }
  const getState = (): CloudState => structuredClone(state)
  const current = (generation: number) => !stopped && generation === epoch
  const check = (generation: number) => { if (!current(generation)) throw new Cancelled() }
  const invalidate = () => { epoch += 1; controller?.abort(); controller = null; state.syncing = false; return epoch }
  const publishSession = () => {
    state.user = session?.user ?? null
    state.device = session?.device ?? null
    state.lastSyncedAt = session?.lastSyncedAt ?? null
    if (session) state.serverUrl = session.serverUrl
  }
  const persistSession = async () => {
    const payload: { version: number; serverUrl: string; encrypted?: string } = { version: 1, serverUrl: state.serverUrl }
    if (session) {
      if (!options.encryption.available()) throw new CloudError('系统安全存储不可用，无法保存登录状态。')
      payload.encrypted = options.encryption.encrypt(JSON.stringify(session)).toString('base64')
    }
    await fs.writeFile(`${filename}.tmp`, JSON.stringify(payload), 'utf8')
    await fs.rename(`${filename}.tmp`, filename)
  }
  try {
    const stored: unknown = JSON.parse(await fs.readFile(filename, 'utf8'))
    if (!record(stored) || stored.version !== 1) throw new CloudError('登录状态文件无效，请重新登录。')
    if (typeof stored.serverUrl === 'string' && stored.serverUrl) state.serverUrl = validateServerOrigin(stored.serverUrl)
    if (typeof stored.encrypted === 'string') {
      if (!options.encryption.available()) throw new CloudError('系统安全存储不可用，请在可用后重新登录。')
      const decoded: unknown = JSON.parse(options.encryption.decrypt(Buffer.from(stored.encrypted, 'base64')))
      if (!record(decoded) || !nonempty(decoded.token) || !record(decoded.user) || !nonempty(decoded.user.id) || !nonempty(decoded.user.email) ||
        typeof decoded.expiresAt !== 'string' || !Number.isFinite(Date.parse(decoded.expiresAt)) || Date.parse(decoded.expiresAt) <= Date.now() ||
        !nonempty(decoded.serverUrl) || !nonempty(decoded.deviceName)) throw new CloudError('登录已过期，请重新登录。')
      session = { token: decoded.token, expiresAt: decoded.expiresAt, user: { id: decoded.user.id, email: decoded.user.email },
        serverUrl: validateServerOrigin(decoded.serverUrl), deviceName: decoded.deviceName,
        device: decoded.device ? deviceFrom(decoded.device) : null, lastSyncedAt: typeof decoded.lastSyncedAt === 'string' ? decoded.lastSyncedAt : null }
      publishSession()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') state.error = error instanceof CloudError ? error.message : '无法读取安全登录状态，请重新登录。'
  }

  const request = async (serverUrl: string, endpoint: string, generation: number, method = 'GET', body?: unknown, token?: string): Promise<unknown> => {
    check(generation)
    const active = new AbortController()
    controller = active
    const timeout = setTimeout(() => active.abort(), 15000)
    try {
      const response = await transport(`${serverUrl}${endpoint}`, {
        method, redirect: 'error', signal: active.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      check(generation)
      if (!response.ok) {
        await response.body?.cancel()
        const messages: Record<number, string> = { 400: '提交的信息无效，请检查输入。', 401: '登录已失效，请检查账号密码或重新登录。', 403: '当前账号没有访问权限。', 404: '服务或设备不存在，请检查服务地址。', 409: '账号已存在，请直接登录。', 429: '请求过于频繁，请稍后重试。' }
        throw new CloudError(messages[response.status] ?? '同步服务暂时不可用，请稍后重试。', response.status)
      }
      // Do not let a broken or untrusted service allocate an unbounded response.
      const reader = response.body?.getReader()
      if (!reader) throw new CloudError('服务返回了空响应。')
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const next = await reader.read()
        check(generation)
        if (next.done) break
        size += next.value.byteLength
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new CloudError('服务响应过大，已停止读取。') }
        chunks.push(next.value)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new CloudError('服务响应格式无效。') }
    } finally {
      clearTimeout(timeout)
      if (controller === active) controller = null
    }
  }

  const failure = async (error: unknown, generation: number) => {
    if (!current(generation) || error instanceof Cancelled) return
    let reportGeneration = generation
    if (error instanceof CloudError && error.status === 401) {
      reportGeneration = invalidate()
      session = null
      publishSession()
      await persistSession().catch(() => undefined)
    }
    if (current(reportGeneration)) state.error = error instanceof CloudError ? error.message : '暂时无法连接或保存云同步状态。记录仍保留在本机，稍后会重试。'
  }
  const sync = async (generation: number) => {
    check(generation)
    if (!session) return
    state.syncing = true
    state.error = null
    const activeSession = session
    try {
      const me = await request(activeSession.serverUrl, '/v1/auth/me', generation, 'GET', undefined, activeSession.token)
      if (!record(me) || !record(me.user) || me.user.id !== activeSession.user.id) throw new CloudError('账号状态不一致，请重新登录。', 401)
      const registration = await request(activeSession.serverUrl, '/v1/devices', generation, 'POST', {
        clientId: journal.clientId, name: activeSession.deviceName, platform: 'windows',
        timeZone: (options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))(),
      }, activeSession.token)
      if (!record(registration)) throw new CloudError('设备注册响应无效。')
      const device = deviceFrom(registration.device)
      if (device.platform !== 'windows' || device.clientId !== journal.clientId) throw new CloudError('服务返回的设备身份与本机不一致。')
      check(generation)
      activeSession.device = device
      publishSession()
      await persistSession()
      check(generation)
      // Persist every revision before it is sent; retries reuse the revision.
      const account = createHash('sha256').update(`${activeSession.serverUrl}\n${activeSession.user.id}`).digest('hex')
      const days = journal.snapshots(account)
      await journal.flush()
      for (const { date, ...snapshot } of days) {
        check(generation)
        const result = await request(activeSession.serverUrl, `/v1/devices/${encodeURIComponent(device.id)}/days/${date}`, generation, 'PUT', snapshot, activeSession.token)
        if (!record(result) || typeof result.accepted !== 'boolean' || !Number.isSafeInteger(result.revision) || result.revision !== snapshot.revision) {
          throw new CloudError('设备记录版本不一致，已保留本机数据。请检查是否复制了其他电脑的数据目录。')
        }
        check(generation)
        journal.acknowledge(account, date, snapshot.revision)
        await journal.flush()
      }
      check(generation)
      activeSession.lastSyncedAt = new Date().toISOString()
      activeSession.device = { ...device, lastSyncedAt: activeSession.lastSyncedAt }
      await persistSession()
      check(generation)
      publishSession()
    } finally { if (current(generation)) state.syncing = false }
  }
  const syncNow = () => {
    if (pendingSync) return pendingSync
    const generation = epoch
    const result = enqueue(async () => {
      if (!current(generation) || !session) return getState()
      try { await sync(generation) } catch (error) { await failure(error, generation) }
      return getState()
    })
    pendingSync = result
    void result.finally(() => { if (pendingSync === result) pendingSync = null })
    return result
  }
  const saveTimer = setInterval(() => {
    void journal.flush().catch(() => { state.error = '本机独立记录暂时未能保存，请检查磁盘空间和数据目录权限。' })
  }, 10000)

  return {
    getState,
    record: journal.record,
    syncNow,
    start() {
      if (syncTimer || stopped) return
      syncTimer = setInterval(() => { void syncNow() }, 60000)
      void syncNow()
    },
    authenticate(input: CloudAuthentication) {
      const generation = invalidate()
      session = null
      publishSession()
      state.error = null
      pendingSync = null
      return enqueue(async () => {
        if (!current(generation)) return getState()
        let established = false
        try {
          await persistSession()
          if (!options.encryption.available()) throw new CloudError('系统安全存储不可用，无法安全登录。')
          if (!record(input) || typeof input.serverUrl !== 'string' || typeof input.email !== 'string' ||
            typeof input.password !== 'string' || typeof input.deviceName !== 'string' || !['login', 'register'].includes(input.mode)) throw new CloudError('登录信息无效。')
          const origin = validateServerOrigin(input.serverUrl.trim())
          const email = input.email.trim()
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new CloudError('请输入有效邮箱。')
          if (input.password.length < 10 || input.password.length > 128) throw new CloudError('密码长度应为 10–128 个字符。')
          const deviceName = input.deviceName.trim()
          if (!deviceName || deviceName.length > 80) throw new CloudError('设备名称应为 1–80 个字符。')
          state.serverUrl = origin
          const authenticated = await request(origin, `/v1/auth/${input.mode}`, generation, 'POST', { email, password: input.password })
          if (!record(authenticated) || !nonempty(authenticated.token) || !record(authenticated.user) || !nonempty(authenticated.user.id) ||
            !nonempty(authenticated.user.email) || typeof authenticated.expiresAt !== 'string' || !Number.isFinite(Date.parse(authenticated.expiresAt)) ||
            Date.parse(authenticated.expiresAt) <= Date.now()) throw new CloudError('登录响应无效。')
          check(generation)
          session = { token: authenticated.token, expiresAt: authenticated.expiresAt, user: { id: authenticated.user.id, email: authenticated.user.email },
            device: null, serverUrl: origin, deviceName, lastSyncedAt: null }
          await persistSession()
          check(generation)
          publishSession()
          established = true
          await sync(generation)
        } catch (error) {
          if (!established && current(generation)) {
            session = null
            publishSession()
            await persistSession().catch(() => undefined)
          }
          await failure(error, generation)
        }
        return getState()
      })
    },
    logout() {
      const previous = session
      const generation = invalidate()
      pendingSync = null
      session = null
      publishSession()
      state.error = null
      return enqueue(async () => {
        if (!current(generation)) return getState()
        try {
          await persistSession()
          if (previous) await request(previous.serverUrl, '/v1/auth/logout', generation, 'POST', undefined, previous.token).catch((error) => {
            if (current(generation) && !(error instanceof CloudError && error.status === 401)) {
              state.error = '本机已退出，上传已停止；服务暂不可达，服务器上的会话将在到期后失效。'
            }
          })
        } catch { if (current(generation)) state.error = '本机登录状态未能清除，请检查数据目录权限后重试。' }
        return getState()
      })
    },
    getSummary(date: string, deviceId?: string): Promise<CloudSummary> {
      const generation = epoch
      return enqueue(async () => {
        try {
          check(generation)
          if (!session) throw new CloudError('请先登录跨设备账号。')
          if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (deviceId !== undefined && (!nonempty(deviceId) || deviceId.length > 256))) throw new CloudError('请选择有效的日期和设备。')
          const result = await request(session.serverUrl, `/v1/summary?date=${encodeURIComponent(date)}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ''}`, generation, 'GET', undefined, session.token)
          return summaryFrom(result, date)
        } catch (error) {
          await failure(error, generation)
          throw new Error(error instanceof Cancelled ? '账号已切换，请重新读取。' : state.error ?? '无法读取跨设备统计。')
        }
      })
    },
    async stop() {
      invalidate()
      stopped = true
      clearInterval(saveTimer)
      if (syncTimer) clearInterval(syncTimer)
      await queue
      await journal.flush()
    },
  }
}
