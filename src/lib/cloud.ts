export type CloudDevice = {
  id: string
  clientId: string
  name: string
  platform: 'windows' | 'android'
  timeZone: string
  lastSyncedAt: string | null
}

export type CloudSummary = {
  date: string
  metric: 'sumDevices'
  totalMs: number
  devices: Array<CloudDevice & { totalMs: number }>
  apps: Array<{
    canonicalId: string
    name: string
    totalMs: number
    devices: Array<{ deviceId: string; name: string; platform: 'windows' | 'android'; totalMs: number }>
  }>
  updatedAt: string | null
}

export type CloudState = {
  serverUrl: string
  user: { id: string; email: string } | null
  device: CloudDevice | null
  syncing: boolean
  lastSyncedAt: string | null
  error: string | null
}

export type CloudAuth = {
  serverUrl: string
  email: string
  password: string
  mode: 'login' | 'register'
  deviceName: string
}

export type CloudApi = {
  getState: () => Promise<CloudState>
  authenticate: (input: CloudAuth) => Promise<CloudState>
  logout: () => Promise<CloudState>
  syncNow: () => Promise<CloudState>
  getSummary: (date: string, deviceId?: string) => Promise<CloudSummary>
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 }
function milliseconds(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function platform(value: unknown): value is 'windows' | 'android' { return value === 'windows' || value === 'android' }

export function validateCloudSummary(value: unknown, date: string): CloudSummary {
  const invalid = () => new Error('服务返回的统计格式无效，请检查服务版本后重试。')
  if (!object(value) || value.date !== date || value.metric !== 'sumDevices' || !milliseconds(value.totalMs) ||
    (value.updatedAt !== null && !text(value.updatedAt)) || !Array.isArray(value.devices) || !Array.isArray(value.apps)) throw invalid()
  for (const device of value.devices) {
    if (!object(device) || !text(device.id) || !text(device.clientId) || !text(device.name) || !platform(device.platform) ||
      !text(device.timeZone) || !milliseconds(device.totalMs) || (device.lastSyncedAt !== null && !text(device.lastSyncedAt))) throw invalid()
  }
  for (const app of value.apps) {
    if (!object(app) || !text(app.canonicalId) || !text(app.name) || !milliseconds(app.totalMs) || !Array.isArray(app.devices)) throw invalid()
    for (const device of app.devices) {
      if (!object(device) || !text(device.deviceId) || !text(device.name) || !platform(device.platform) || !milliseconds(device.totalMs)) throw invalid()
    }
  }
  return value as CloudSummary
}

export function cloudError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error: )?/, '')
    : '连接暂时不可用，请稍后重试。'
}

export function normalizeServerUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的服务地址，例如 https://time.example.com。') }
  const host = url.hostname.toLowerCase()
  const octets = host.split('.').map(Number)
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && octets.every((part) => part >= 0 && part <= 255)
  const local = host === 'localhost' || host === '[::1]' || (ipv4 && (
    octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  ))
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务地址只需域名和端口，不包含路径、账号或其他参数。')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('公网服务请使用 HTTPS；HTTP 仅支持本机或局域网地址。')
  }
  return url.origin
}

// Browser viewing never creates a collecting device. The token lives only in
// this closure, so refreshing/closing the page ends the local browser session.
export function createBrowserCloudApi(): CloudApi {
  let token = ''
  let generation = 0
  let state: CloudState = { serverUrl: '', user: null, device: null, syncing: false, lastSyncedAt: null, error: null }
  const snapshot = () => ({ ...state, user: state.user ? { ...state.user } : null })
  async function request<T>(origin: string, path: string, bearer: string, method = 'GET', body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      })
      const reader = response.body?.getReader()
      if (!reader) throw new Error('服务没有返回内容，请检查地址。')
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('服务响应过大，已停止读取。') }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const result: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (!response.ok) {
        if (response.status === 401 && bearer && bearer === token) {
          token = ''
          generation += 1
          state = { ...state, user: null, error: '登录已过期，请重新登录。' }
        }
        throw new Error(object(result) && text(result.error) ? result.error : '请求失败，请重试。')
      }
      return result as T
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error('暂时连不上服务，请检查网络和地址；浏览器访问还需要服务允许当前页面来源。')
      }
      if (error instanceof SyntaxError) throw new Error('服务返回了无法识别的内容，请检查地址。')
      throw error
    } finally { clearTimeout(timer) }
  }
  return {
    async getState() { return snapshot() },
    async authenticate(input) {
      const serverUrl = normalizeServerUrl(input.serverUrl)
      const ownGeneration = ++generation
      const result = await request<{ token: string; user: { id: string; email: string } }>(
        serverUrl, `/v1/auth/${input.mode}`, '', 'POST', { email: input.email.trim(), password: input.password }
      )
      if (!object(result) || !text(result.token) || !object(result.user) || !text(result.user.id) || !text(result.user.email)) {
        throw new Error('服务返回的登录信息无效，请检查服务地址。')
      }
      if (ownGeneration !== generation) {
        await request(serverUrl, '/v1/auth/logout', result.token, 'POST').catch(() => undefined)
        return snapshot()
      }
      token = result.token
      state = { serverUrl, user: result.user, device: null, syncing: false, lastSyncedAt: null, error: null }
      return snapshot()
    },
    async logout() {
      const previous = { token, serverUrl: state.serverUrl }
      generation += 1
      token = ''
      state = { ...state, user: null, device: null, error: null, lastSyncedAt: null }
      if (previous.token) {
        await request(previous.serverUrl, '/v1/auth/logout', previous.token, 'POST').catch(() => {
          state.error = '本页已退出；服务暂不可达，服务器上的会话将在到期后失效。'
        })
      }
      return snapshot()
    },
    async syncNow() { return snapshot() },
    async getSummary(date, deviceId) {
      if (!token) throw new Error('请先登录。')
      const ownGeneration = generation
      const params = new URLSearchParams({ date })
      if (deviceId) params.set('deviceId', deviceId)
      const result = await request<CloudSummary>(state.serverUrl, `/v1/summary?${params}`, token)
      if (ownGeneration !== generation) throw new Error('账号已变更，请重新读取统计。')
      return validateCloudSummary(result, date)
    },
  }
}

export function demoCloudSummary(date: string, deviceId = ''): CloudSummary {
  const base = { timeZone: 'Asia/Shanghai', lastSyncedAt: new Date().toISOString() }
  const devices: CloudSummary['devices'] = [
    { ...base, id: 'demo-pc', clientId: 'demo-pc', name: '我的电脑', platform: 'windows', totalMs: 13740000 },
    { ...base, id: 'demo-phone', clientId: 'demo-phone', name: '我的手机', platform: 'android', totalMs: 6480000 },
  ]
  const sources: Array<[string, string, number, number]> = [
    ['wechat', '微信', 2400000, 2580000],
    ['bilibili', '哔哩哔哩', 3000000, 2100000],
    ['windows:code', 'Visual Studio Code', 6000000, 0],
    ['windows:edge', 'Microsoft Edge', 2340000, 0],
    ['android:camera', '相机', 0, 1800000],
  ]
  const apps = sources.map(([canonicalId, name, pc, phone]) => {
    const breakdown = devices.map((device, index) => ({ deviceId: device.id, name: device.name, platform: device.platform, totalMs: index ? phone : pc }))
      .filter((item) => item.totalMs && (!deviceId || item.deviceId === deviceId))
    return { canonicalId, name, devices: breakdown, totalMs: breakdown.reduce((sum, item) => sum + item.totalMs, 0) }
  }).filter((app) => app.totalMs).sort((a, b) => b.totalMs - a.totalMs)
  return { date, metric: 'sumDevices', totalMs: apps.reduce((sum, app) => sum + app.totalMs, 0), devices: devices.filter((device) => !deviceId || device.id === deviceId), apps, updatedAt: base.lastSyncedAt }
}
