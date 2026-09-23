export class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ApiError(400, '请求字段无效')
  }
  return value
}

function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new ApiError(400, `${label}无效`)
  }
  return value.trim()
}

export function credentials(value) {
  object(value, ['email', 'password'])
  const email = text(value.email, 254, '邮箱').toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ApiError(400, '邮箱格式无效')
  if (typeof value.password !== 'string' || value.password.length < 10 || value.password.length > 128) {
    throw new ApiError(400, '密码长度须为 10–128 个字符')
  }
  return { email, password: value.password }
}

export function timeZone(value) {
  const zone = text(value, 64, '时区')
  if (/^[+-]/u.test(zone)) throw new ApiError(400, '请提供有效的 IANA 时区')
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format() } catch { throw new ApiError(400, '请提供有效的 IANA 时区') }
  return zone
}

export function deviceInput(value) {
  object(value, ['clientId', 'name', 'platform', 'timeZone'])
  if (value.platform !== 'windows' && value.platform !== 'android') throw new ApiError(400, '设备平台无效')
  return {
    clientId: text(value.clientId, 128, '设备标识'), name: text(value.name, 120, '设备名称'),
    platform: value.platform, timeZone: timeZone(value.timeZone),
  }
}

export function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ApiError(400, '日期格式须为 YYYY-MM-DD')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ApiError(400, '日期无效')
  return value
}

export function dailySnapshot(value) {
  object(value, ['revision', 'timeZone', 'apps'])
  if (!Number.isSafeInteger(value.revision) || value.revision <= 0) throw new ApiError(400, '版本号须为正整数')
  if (!Array.isArray(value.apps) || value.apps.length > 2000) throw new ApiError(400, '每天最多可上传 2000 个应用')
  const ids = new Set()
  let total = 0
  const apps = value.apps.map((entry) => {
    object(entry, ['sourceId', 'sourceName', 'totalMs'])
    const sourceId = text(entry.sourceId, 256, '应用标识').toLowerCase()
    if (ids.has(sourceId)) throw new ApiError(400, '应用标识不可重复')
    ids.add(sourceId)
    if (!Number.isSafeInteger(entry.totalMs) || entry.totalMs < 0) throw new ApiError(400, '使用时长须为非负整数毫秒')
    total += entry.totalMs
    if (total > 90_000_000) throw new ApiError(400, '单台设备每天的总时长不得超过 25 小时')
    return { sourceId, sourceName: text(entry.sourceName, 200, '应用名称'), totalMs: entry.totalMs }
  })
  return { revision: value.revision, timeZone: timeZone(value.timeZone), apps }
}

const aliases = {
  windows: new Map([
    ...['wechat', 'weixin', 'wechat.exe', 'weixin.exe', '微信'].map((id) => [id, 'wechat']),
    ...['bilibili', 'bilibili.exe', '哔哩哔哩', 'site:bilibili'].map((id) => [id, 'bilibili']),
    ...['qq', 'qq.exe'].map((id) => [id, 'qq']),
  ]),
  android: new Map([['com.tencent.mm', 'wechat'], ['tv.danmaku.bili', 'bilibili'], ['com.tencent.mobileqq', 'qq']]),
}
const knownNames = { wechat: '微信', bilibili: '哔哩哔哩', qq: 'QQ' }

export function canonicalApp(platform, sourceId, sourceName) {
  const normalized = sourceId.toLowerCase()
  const canonicalId = aliases[platform].get(normalized)
  return canonicalId ? { canonicalId, name: knownNames[canonicalId] } : { canonicalId: `${platform}:${normalized}`, name: sourceName }
}
